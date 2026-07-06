const CalendarProvider = require('../models/CalendarProvider');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const OUTLOOK_SCOPES = 'Calendars.ReadWrite offline_access';

const OUTLOOK_AUTHORITY = 'https://login.microsoftonline.com/common';
const OUTLOOK_GRAPH = 'https://graph.microsoft.com/v1.0';
const ICALENDAR_URL = 'https://caldav.icloud.com';

let _google = null;
function getGoogle() {
  if (!_google) {
    try {
      _google = require('googleapis').google;
    } catch (e) {
      return null;
    }
  }
  return _google;
}

let _createClient = null;
function getCreateClient() {
  if (!_createClient) {
    try {
      _createClient = require('webdav').createClient;
    } catch (e) {
      return null;
    }
  }
  return _createClient;
}

const getGoogleOAuth2Client = () => {
  const g = getGoogle();
  if (!g) throw new Error('googleapis package not available');
  return new g.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

function buildEventBody(appointment, business, service) {
  const startDateTime = new Date(`${appointment.date.toISOString().split('T')[0]}T${appointment.startTime}:00`);
  const endDateTime = new Date(`${appointment.date.toISOString().split('T')[0]}T${appointment.endTime}:00`);

  const event = {
    summary: `${service?.name || 'Appointment'} - ${business?.name || 'Business'}`,
    description: `Client: ${appointment.client?.name || 'N/A'}\nEmail: ${appointment.client?.email || 'N/A'}\nPhone: ${appointment.client?.phone || 'N/A'}\nNotes: ${appointment.notes || 'None'}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: business?.timezone || 'UTC'
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: business?.timezone || 'UTC'
    },
    status: appointment.status === 'cancelled' ? 'cancelled' : 'confirmed'
  };

  if (appointment.client?.email) {
    event.attendees = [{ email: appointment.client.email, displayName: appointment.client.name }];
  }

  return event;
}

async function refreshGoogleToken(providerDoc) {
  const oauth2Client = getGoogleOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: providerDoc.refreshToken });
  const { credentials } = await oauth2Client.refreshAccessToken();
  providerDoc.accessToken = credentials.access_token;
  providerDoc.tokenExpiry = credentials.expiry_date ? new Date(credentials.expiry_date) : null;
  await providerDoc.save();
  return providerDoc;
}

async function refreshOutlookToken(providerDoc) {
  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    client_secret: process.env.OUTLOOK_CLIENT_SECRET,
    refresh_token: providerDoc.refreshToken,
    grant_type: 'refresh_token',
    scope: OUTLOOK_SCOPES
  });

  const res = await fetch(`${OUTLOOK_AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) throw new Error('Failed to refresh Outlook token');

  const data = await res.json();
  providerDoc.accessToken = data.access_token;
  providerDoc.refreshToken = data.refresh_token || providerDoc.refreshToken;
  providerDoc.tokenExpiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
  await providerDoc.save();
  return providerDoc;
}

async function getValidProvider(businessId, provider) {
  const providerDoc = await CalendarProvider.findOne({ business: businessId, provider, isConnected: true });
  if (!providerDoc) return null;

  if (provider !== 'apple' && providerDoc.tokenExpiry && new Date() > providerDoc.tokenExpiry) {
    try {
      if (provider === 'google') await refreshGoogleToken(providerDoc);
      else if (provider === 'outlook') await refreshOutlookToken(providerDoc);
    } catch (err) {
      providerDoc.isConnected = false;
      await providerDoc.save();
      return null;
    }
  }

  return providerDoc;
}

async function createGoogleEvent(appointment, business, service) {
  const providerDoc = await getValidProvider(business._id, 'google');
  if (!providerDoc) return null;

  const oauth2Client = getGoogleOAuth2Client();
  oauth2Client.setCredentials({ access_token: providerDoc.accessToken });
  const g = getGoogle();
  if (!g) return null;
  const calendar = g.calendar({ version: 'v3', auth: oauth2Client });
  const event = buildEventBody(appointment, business, service);

  const res = await calendar.events.insert({
    calendarId: providerDoc.selectedCalendarId || 'primary',
    requestBody: event
  });

  return { eventId: res.data.id, provider: 'google', calendarId: res.data.organizer?.email || 'primary' };
}

async function updateGoogleEvent(appointment, business, service) {
  const calEvent = appointment.calendarEvents?.find(e => e.provider === 'google');
  if (!calEvent) return createGoogleEvent(appointment, business, service);

  const providerDoc = await getValidProvider(business._id, 'google');
  if (!providerDoc) return null;

  const oauth2Client = getGoogleOAuth2Client();
  oauth2Client.setCredentials({ access_token: providerDoc.accessToken });
  const g = getGoogle();
  if (!g) return null;
  const calendar = g.calendar({ version: 'v3', auth: oauth2Client });
  const event = buildEventBody(appointment, business, service);

  await calendar.events.update({
    calendarId: calEvent.calendarId || providerDoc.selectedCalendarId || 'primary',
    eventId: calEvent.eventId,
    requestBody: event
  });

  return calEvent;
}

async function deleteGoogleEvent(appointment) {
  const calEvent = appointment.calendarEvents?.find(e => e.provider === 'google');
  if (!calEvent) return;

  const providerDoc = await getValidProvider(appointment.business._id || appointment.business, 'google');
  if (!providerDoc) return;

  const oauth2Client = getGoogleOAuth2Client();
  oauth2Client.setCredentials({ access_token: providerDoc.accessToken });
  const g = getGoogle();
  if (!g) return;
  const calendar = g.calendar({ version: 'v3', auth: oauth2Client });

  try {
    await calendar.events.delete({
      calendarId: calEvent.calendarId || 'primary',
      eventId: calEvent.eventId
    });
  } catch (err) {
    if (!err.message?.includes('410') && !err.message?.includes('404')) throw err;
  }
}

async function createOutlookEvent(appointment, business, service) {
  const providerDoc = await getValidProvider(business._id, 'outlook');
  if (!providerDoc) return null;

  const startDateTime = new Date(`${appointment.date.toISOString().split('T')[0]}T${appointment.startTime}:00`);
  const endDateTime = new Date(`${appointment.date.toISOString().split('T')[0]}T${appointment.endTime}:00`);

  const event = {
    subject: `${service?.name || 'Appointment'} - ${business?.name || 'Business'}`,
    body: {
      contentType: 'text',
      content: `Client: ${appointment.client?.name || 'N/A'}\nEmail: ${appointment.client?.email || 'N/A'}\nPhone: ${appointment.client?.phone || 'N/A'}\nNotes: ${appointment.notes || 'None'}`
    },
    start: { dateTime: startDateTime.toISOString(), timeZone: business?.timezone || 'UTC' },
    end: { dateTime: endDateTime.toISOString(), timeZone: business?.timezone || 'UTC' },
    isCancelled: appointment.status === 'cancelled'
  };

  if (appointment.client?.email) {
    event.attendees = [{ emailAddress: { address: appointment.client.email, name: appointment.client.name } }];
  }

  const res = await fetch(`${OUTLOOK_GRAPH}/me/calendar/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${providerDoc.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!res.ok) throw new Error(`Outlook API error: ${res.status}`);
  const data = await res.json();
  return { eventId: data.id, provider: 'outlook', calendarId: 'primary' };
}

async function updateOutlookEvent(appointment, business, service) {
  const calEvent = appointment.calendarEvents?.find(e => e.provider === 'outlook');
  if (!calEvent) return createOutlookEvent(appointment, business, service);

  const providerDoc = await getValidProvider(business._id, 'outlook');
  if (!providerDoc) return null;

  const startDateTime = new Date(`${appointment.date.toISOString().split('T')[0]}T${appointment.startTime}:00`);
  const endDateTime = new Date(`${appointment.date.toISOString().split('T')[0]}T${appointment.endTime}:00`);

  const event = {
    subject: `${service?.name || 'Appointment'} - ${business?.name || 'Business'}`,
    body: {
      contentType: 'text',
      content: `Client: ${appointment.client?.name || 'N/A'}\nEmail: ${appointment.client?.email || 'N/A'}\nPhone: ${appointment.client?.phone || 'N/A'}\nNotes: ${appointment.notes || 'None'}`
    },
    start: { dateTime: startDateTime.toISOString(), timeZone: business?.timezone || 'UTC' },
    end: { dateTime: endDateTime.toISOString(), timeZone: business?.timezone || 'UTC' },
    isCancelled: appointment.status === 'cancelled'
  };

  if (appointment.client?.email) {
    event.attendees = [{ emailAddress: { address: appointment.client.email, name: appointment.client.name } }];
  }

  const res = await fetch(`${OUTLOOK_GRAPH}/me/calendar/events/${calEvent.eventId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${providerDoc.accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(event)
  });

  if (!res.ok) throw new Error(`Outlook API error: ${res.status}`);
  return calEvent;
}

async function deleteOutlookEvent(appointment) {
  const calEvent = appointment.calendarEvents?.find(e => e.provider === 'outlook');
  if (!calEvent) return;

  const providerDoc = await getValidProvider(appointment.business?._id || appointment.business, 'outlook');
  if (!providerDoc) return;

  const res = await fetch(`${OUTLOOK_GRAPH}/me/calendar/events/${calEvent.eventId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${providerDoc.accessToken}` }
  });

  if (!res.ok && res.status !== 404) throw new Error(`Outlook delete error: ${res.status}`);
}

async function createAppleEvent(appointment, business, service) {
  const providerDoc = await getValidProvider(business._id, 'apple');
  if (!providerDoc) return null;

  const createClient = getCreateClient();
  if (!createClient) return null;
  const client = createClient(ICALENDAR_URL, {
    username: providerDoc.email,
    password: providerDoc.applePassword,
    authType: 'password'
  });

  const calendarId = providerDoc.selectedCalendarId || `${providerDoc.email}/calendar/`;
  const uid = `appointment-${appointment._id}-${Date.now()}`;
  const startDate = `${appointment.date.toISOString().split('T')[0]}T${appointment.startTime}:00`;
  const endDate = `${appointment.date.toISOString().split('T')[0]}T${appointment.endTime}:00`;

  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Weavo AI//Appointment//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${startDate.replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTEND:${endDate.replace(/[-:]/g, '').split('.')[0]}Z`,
    `SUMMARY:${service?.name || 'Appointment'} - ${business?.name || 'Business'}`,
    `DESCRIPTION:Client: ${appointment.client?.name || 'N/A'}\\nEmail: ${appointment.client?.email || 'N/A'}\\nPhone: ${appointment.client?.phone || 'N/A'}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const fileName = `${uid}.ics`;
  await client.putFileContents(`${calendarId}${fileName}`, icsContent, { contentType: 'text/calendar' });

  return { eventId: uid, provider: 'apple', calendarId };
}

async function deleteAppleEvent(appointment) {
  const calEvent = appointment.calendarEvents?.find(e => e.provider === 'apple');
  if (!calEvent) return;

  const providerDoc = await getValidProvider(appointment.business?._id || appointment.business, 'apple');
  if (!providerDoc) return;

  const createClient = getCreateClient();
  if (!createClient) return;
  const client = createClient(ICALENDAR_URL, {
    username: providerDoc.email,
    password: providerDoc.applePassword,
    authType: 'password'
  });

  try {
    const calendarId = calEvent.calendarId || `${providerDoc.email}/calendar/`;
    const fileName = `${calEvent.eventId}.ics`;
    await client.deleteFile(`${calendarId}${fileName}`);
  } catch (err) {
    if (!err.message?.includes('404')) throw err;
  }
}

async function syncCreateAppointment(appointment, business, service) {
  const results = [];
  const errors = [];

  try {
    const googleResult = await createGoogleEvent(appointment, business, service);
    if (googleResult) results.push(googleResult);
  } catch (err) {
    errors.push({ provider: 'google', error: err.message });
  }

  try {
    const outlookResult = await createOutlookEvent(appointment, business, service);
    if (outlookResult) results.push(outlookResult);
  } catch (err) {
    errors.push({ provider: 'outlook', error: err.message });
  }

  try {
    const appleResult = await createAppleEvent(appointment, business, service);
    if (appleResult) results.push(appleResult);
  } catch (err) {
    errors.push({ provider: 'apple', error: err.message });
  }

  return { results, errors };
}

async function syncUpdateAppointment(appointment, business, service) {
  const errors = [];

  try {
    await updateGoogleEvent(appointment, business, service);
  } catch (err) {
    errors.push({ provider: 'google', error: err.message });
  }

  try {
    await updateOutlookEvent(appointment, business, service);
  } catch (err) {
    errors.push({ provider: 'outlook', error: err.message });
  }

  try {
    const calEvent = appointment.calendarEvents?.find(e => e.provider === 'apple');
    if (calEvent) {
      await deleteAppleEvent(appointment);
      await createAppleEvent(appointment, business, service);
    }
  } catch (err) {
    errors.push({ provider: 'apple', error: err.message });
  }

  return { errors };
}

async function syncDeleteAppointment(appointment) {
  const errors = [];

  try {
    await deleteGoogleEvent(appointment);
  } catch (err) {
    errors.push({ provider: 'google', error: err.message });
  }

  try {
    await deleteOutlookEvent(appointment);
  } catch (err) {
    errors.push({ provider: 'outlook', error: err.message });
  }

  try {
    await deleteAppleEvent(appointment);
  } catch (err) {
    errors.push({ provider: 'apple', error: err.message });
  }

  return { errors };
}

function getGoogleAuthUrl() {
  const oauth2Client = getGoogleOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
}

async function handleGoogleCallback(code, businessId) {
  const oauth2Client = getGoogleOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  oauth2Client.setCredentials(tokens);
  const g = getGoogle();
  if (!g) throw new Error('googleapis package not available');
  const calendar = g.calendar({ version: 'v3', auth: oauth2Client });
  const { data: profile } = await calendar.calendarList.list();

  const primaryCalendar = profile.items?.find(c => c.primary) || profile.items?.[0];

  const providerData = {
    business: businessId,
    provider: 'google',
    email: tokens.id_token ? JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString()).email : null,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    isConnected: true,
    selectedCalendarId: primaryCalendar?.id || 'primary',
    calendars: (profile.items || []).map(c => ({
      id: c.id,
      name: c.summary,
      isPrimary: c.primary || false
    }))
  };

  await CalendarProvider.findOneAndUpdate(
    { business: businessId, provider: 'google' },
    providerData,
    { upsert: true, new: true }
  );
}

function getOutlookAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES
  });
  return `${OUTLOOK_AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function handleOutlookCallback(code, businessId) {
  const params = new URLSearchParams({
    client_id: process.env.OUTLOOK_CLIENT_ID,
    client_secret: process.env.OUTLOOK_CLIENT_SECRET,
    code,
    redirect_uri: process.env.OUTLOOK_REDIRECT_URI,
    grant_type: 'authorization_code',
    scope: OUTLOOK_SCOPES
  });

  const res = await fetch(`${OUTLOOK_AUTHORITY}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) throw new Error('Outlook token exchange failed');
  const data = await res.json();

  const providerData = {
    business: businessId,
    provider: 'outlook',
    email: data.id_token ? JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString()).preferred_username : null,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenExpiry: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    isConnected: true,
    selectedCalendarId: 'primary',
    calendars: [{ id: 'primary', name: 'Primary Calendar', isPrimary: true }]
  };

  await CalendarProvider.findOneAndUpdate(
    { business: businessId, provider: 'outlook' },
    providerData,
    { upsert: true, new: true }
  );
}

async function connectAppleCalendar(businessId, email, password) {
  const createClient = getCreateClient();
  if (!createClient) throw new Error('webdav package not available');
  const client = createClient(ICALENDAR_URL, {
    username: email,
    password: password,
    authType: 'password'
  });

  let directories;
  try {
    directories = await client.getDirectoryContents('/');
  } catch (err) {
    throw new Error('Failed to connect to iCloud CalDAV. Check your email and app-specific password.');
  }

  const calendars = (directories || [])
    .filter(d => d.type === 'directory' && d.filename.includes('calendar'))
    .map(d => ({
      id: d.filename,
      name: d.basename || d.filename,
      isPrimary: false
    }));

  const providerData = {
    business: businessId,
    provider: 'apple',
    email,
    applePassword: password,
    isConnected: true,
    selectedCalendarId: calendars[0]?.id || `${email}/calendar/`,
    calendars
  };

  await CalendarProvider.findOneAndUpdate(
    { business: businessId, provider: 'apple' },
    providerData,
    { upsert: true, new: true }
  );
}

module.exports = {
  syncCreateAppointment,
  syncUpdateAppointment,
  syncDeleteAppointment,
  getGoogleAuthUrl,
  handleGoogleCallback,
  getOutlookAuthUrl,
  handleOutlookCallback,
  connectAppleCalendar,
  getValidProvider,
  CalendarProvider
};
