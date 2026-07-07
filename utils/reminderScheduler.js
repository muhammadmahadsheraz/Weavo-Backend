const cron = require('node-cron');
const Appointment = require('../models/Appointment');
const Business = require('../models/Business');
const { sendGmailReminder } = require('./calendarSync');

async function processReminders() {
  const now = new Date();

  const businesses = await Business.find({ 'settings.reminderHours': { $exists: true } });

  for (const biz of businesses) {
    const hoursBefore = biz.settings?.reminderHours || 24;

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfWindow = new Date(now.getTime() + (hoursBefore + 2) * 60 * 60 * 1000);

    const appointments = await Appointment.find({
      business: biz._id,
      status: 'confirmed',
      date: { $gte: startOfToday, $lte: endOfWindow },
      'reminders': { $not: { $elemMatch: { type: 'email', status: 'sent' } } }
    }).populate('business service');

    for (const apt of appointments) {
      const [hour, minute] = apt.startTime.split(':').map(Number);
      const aptDate = new Date(apt.date);
      aptDate.setHours(hour, minute, 0, 0);

      const diffMs = aptDate.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours <= hoursBefore && diffHours > 0) {
        try {
          await sendGmailReminder(apt, apt.client.email, 'reminder');

          apt.reminders.push({
            type: 'email',
            sentAt: new Date(),
            status: 'sent'
          });

          await apt.save();
          console.log(`Reminder sent for appointment ${apt._id} (${apt.client.name})`);
        } catch (err) {
          console.error(`Reminder failed for appointment ${apt._id}:`, err.message);

          apt.reminders.push({
            type: 'email',
            sentAt: new Date(),
            status: 'failed'
          });

          await apt.save();
        }
      }
    }
  }
}

let task = null;

function startReminderScheduler() {
  if (task) return;
  task = cron.schedule('*/30 * * * *', () => {
    processReminders().catch(err => console.error('Reminder scheduler error:', err));
  });
  console.log('Reminder scheduler started (every 30 min)');

  processReminders().catch(err => console.error('Initial reminder run error:', err));
}

function stopReminderScheduler() {
  if (task) {
    task.stop();
    task = null;
    console.log('Reminder scheduler stopped');
  }
}

module.exports = { startReminderScheduler, stopReminderScheduler };
