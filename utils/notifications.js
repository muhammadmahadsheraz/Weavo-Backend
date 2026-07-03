const nodemailer = require('nodemailer');

// Lazily create transport so missing env vars don't crash the server on startup
const getTransporter = () => {
  const config = {
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  };
  if (process.env.EMAIL_HOST) {
    config.host = process.env.EMAIL_HOST;
    config.port = parseInt(process.env.EMAIL_PORT) || 587;
    config.secure = process.env.EMAIL_PORT === '465';
  } else if (process.env.EMAIL_SERVICE) {
    config.service = process.env.EMAIL_SERVICE;
  }
  return nodemailer.createTransport(config);
};

// Telegram Bot API (Free Alternative to Twilio)
const sendTelegramMessage = async (chatId, message) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      console.log('TELEGRAM_BOT_TOKEN not configured');
      return { success: false, error: 'Telegram bot token not configured' };
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });

    const data = await response.json();
    
    if (data.ok) {
      return { success: true, messageId: data.result.message_id };
    } else {
      return { success: false, error: data.description };
    }
  } catch (error) {
    console.error('Telegram sending error:', error);
    return { success: false, error: error.message };
  }
};

const sendEmail = async (to, subject, html) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.warn('Email not configured — skipping sendEmail');
    return { success: false, error: 'Email not configured' };
  }
  try {
    const transporter = getTransporter();
    const mailOptions = {
      from: `"AI Appointment Booking" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html
    };

    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('Email sending error:', error);
    return { success: false, error: error.message };
  }
};

const sendWhatsApp = async (to, body) => {
  // Try Telegram first (free)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    // Convert phone to chat ID (you'll need to store this mapping)
    // For now, return a placeholder
    console.log('WhatsApp via Telegram not implemented - use Telegram directly');
    return { success: false, error: 'Use Telegram bot instead' };
  }
  
  // Fallback to Twilio if configured
  try {
    const twilio = require('twilio');
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    
    const message = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
      to: `whatsapp:${to}`,
      body
    });
    return { success: true, sid: message.sid };
  } catch (error) {
    console.error('WhatsApp sending error:', error);
    return { success: false, error: error.message };
  }
};

const sendSMS = async (to, body) => {
  // Fallback to Twilio if configured
  try {
    const twilio = require('twilio');
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    
    const message = await client.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body
    });
    return { success: true, sid: message.sid };
  } catch (error) {
    console.error('SMS sending error:', error);
    return { success: false, error: error.message };
  }
};

const sendEmailReminder = async (appointment, clientEmail) => {
  const business = appointment.business;
  const service = appointment.service;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Appointment Reminder</h2>
      <p>You have an upcoming appointment:</p>
      <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <p><strong>Business:</strong> ${business.name}</p>
        <p><strong>Service:</strong> ${service.name}</p>
        <p><strong>Date:</strong> ${new Date(appointment.date).toLocaleDateString()}</p>
        <p><strong>Time:</strong> ${appointment.startTime} - ${appointment.endTime}</p>
        <p><strong>Duration:</strong> ${service.duration} minutes</p>
        <p><strong>Price:</strong> ${service.price} ${service.currency}</p>
      </div>
      <p>Please arrive 10 minutes before your scheduled time.</p>
      <p>If you need to reschedule or cancel, please contact us.</p>
    </div>
  `;

  return sendEmail(clientEmail, 'Appointment Reminder', html);
};

const sendTelegramReminder = async (appointment, chatId) => {
  const business = appointment.business;
  const service = appointment.service;
  
  const message = `
    <b>Appointment Reminder</b>
    
    📍 <b>${business.name}</b>
    🛠️ ${service.name}
    📅 ${new Date(appointment.date).toLocaleDateString()}
    🕐 ${appointment.startTime} - ${appointment.endTime}
    ⏱️ ${service.duration} minutes
    💰 $${service.price}
    
    Please arrive 10 minutes early.
  `;

  return sendTelegramMessage(chatId, message);
};

module.exports = {
  sendEmail,
  sendTelegramMessage,
  sendWhatsApp,
  sendSMS,
  sendEmailReminder,
  sendTelegramReminder
};