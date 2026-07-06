const CalendarProvider = require('../models/CalendarProvider');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/gmail.send'
];

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

async function getValidProvider(businessId) {
  const providerDoc = await CalendarProvider.findOne({ business: businessId, provider: 'google', isConnected: true });
  if (!providerDoc) return null;

  if (providerDoc.tokenExpiry && new Date() > providerDoc.tokenExpiry) {
    try {
      await refreshGoogleToken(providerDoc);
    } catch (err) {
      providerDoc.isConnected = false;
      await providerDoc.save();
      return null;
    }
  }

  return providerDoc;
}

async function createGoogleEvent(appointment, business, service) {
  const providerDoc = await getValidProvider(business._id);
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

  const providerDoc = await getValidProvider(business._id);
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

  const providerDoc = await getValidProvider(appointment.business._id || appointment.business);
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

async function syncCreateAppointment(appointment, business, service) {
  try {
    const result = await createGoogleEvent(appointment, business, service);
    return { results: result ? [result] : [], errors: [] };
  } catch (err) {
    return { results: [], errors: [{ provider: 'google', error: err.message }] };
  }
}

async function syncUpdateAppointment(appointment, business, service) {
  try {
    await updateGoogleEvent(appointment, business, service);
  } catch (err) {
    return { errors: [{ provider: 'google', error: err.message }] };
  }
  return { errors: [] };
}

async function syncDeleteAppointment(appointment) {
  try {
    await deleteGoogleEvent(appointment);
  } catch (err) {
    return { errors: [{ provider: 'google', error: err.message }] };
  }
  return { errors: [] };
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

async function sendGmailReminder(appointment, clientEmail) {
  const { business: businessId, service: serviceId } = appointment;
  const provider = await CalendarProvider.findOne({
    business: businessId, provider: 'google', isConnected: true
  });
  if (!provider) throw new Error('No Google Calendar connected');

  const oauth2Client = getGoogleOAuth2Client();
  oauth2Client.setCredentials({
    access_token: provider.accessToken,
    refresh_token: provider.refreshToken
  });

  if (provider.tokenExpiry && new Date() > provider.tokenExpiry) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    provider.accessToken = credentials.access_token;
    provider.tokenExpiry = credentials.expiry_date ? new Date(credentials.expiry_date) : null;
    await provider.save();
  }

  const g = getGoogle();
  if (!g) throw new Error('googleapis package not available');

  const gmail = g.gmail({ version: 'v1', auth: oauth2Client });

  const biz = appointment.business;
  const svc = appointment.service;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Appointment Confirmed</h2>
      <p>Your appointment has been confirmed!</p>
      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Business:</strong> ${biz.name}</p>
        <p><strong>Service:</strong> ${svc.name}</p>
        <p><strong>Date:</strong> ${new Date(appointment.date).toLocaleDateString()}</p>
        <p><strong>Time:</strong> ${appointment.startTime} - ${appointment.endTime}</p>
        <p><strong>Duration:</strong> ${svc.duration} minutes</p>
        <p><strong>Price:</strong> ${svc.price} ${svc.currency || 'USD'}</p>
      </div>
      <p>Please arrive 10 minutes before your scheduled time.</p>
      <p>If you need to reschedule or cancel, please contact us.</p>
    </div>
  `;

  const email = [
    `From: ${provider.email || 'me'}`,
    `To: ${clientEmail}`,
    'Subject: Appointment Confirmed',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    html
  ].join('\r\n');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(email, 'utf-8').toString('base64url') }
  });
}

module.exports = {
  syncCreateAppointment,
  syncUpdateAppointment,
  syncDeleteAppointment,
  getGoogleAuthUrl,
  handleGoogleCallback,
  getValidProvider,
  sendGmailReminder,
  CalendarProvider
};
