const express = require('express');
const { body, validationResult } = require('express-validator');
const Business = require('../models/Business');
const Service  = require('../models/Service');
const Appointment = require('../models/Appointment');
const { sendEmailReminder } = require('../utils/notifications');
const { generateReceptionistResponse } = require('../utils/aiReceptionist');

const router = express.Router();

// @route   GET /api/public/book/:slug
// @desc    Get public business info + services for booking page
// @access  Public
router.get('/book/:slug', async (req, res) => {
  try {
    const business = await Business.findOne({ slug: req.params.slug, isActive: true })
      .select('-owner -staff -settings -__v')
      .lean();

    if (!business) return res.status(404).json({ message: 'Business not found' });

    const services = await Service.find({ business: business._id, isAvailable: true })
      .select('name description duration price currency category')
      .lean();

    res.json({ business, services });
  } catch (error) {
    console.error('Public book error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/public/book/:slug/slots
// @desc    Get available time slots for a date
// @access  Public
router.get('/book/:slug/slots', async (req, res) => {
  try {
    const { date, serviceId } = req.query;
    if (!date || !serviceId) return res.status(400).json({ message: 'date and serviceId are required' });

    const business = await Business.findOne({ slug: req.params.slug, isActive: true });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const service = await Service.findById(serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found' });

    // Get day of week from date
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayName  = dayNames[new Date(date).getDay()];
    const hours    = business.workingHours?.[dayName];

    if (!hours?.isOpen) return res.json({ slots: [] });

    // Generate slots from open to close based on service duration + buffer
    const buffer   = business.settings?.bufferTime || 0;
    const slotMins = service.duration + buffer;

    const [openH, openM]   = hours.open.split(':').map(Number);
    const [closeH, closeM] = hours.close.split(':').map(Number);
    const openTotal  = openH  * 60 + openM;
    const closeTotal = closeH * 60 + closeM;

    const allSlots = [];
    for (let t = openTotal; t + service.duration <= closeTotal; t += slotMins) {
      const h = String(Math.floor(t / 60)).padStart(2, '0');
      const m = String(t % 60).padStart(2, '0');
      allSlots.push(`${h}:${m}`);
    }

    // Remove already booked slots
    const booked = await Appointment.find({
      business: business._id,
      date: new Date(date),
      status: { $in: ['pending', 'confirmed'] }
    }).select('startTime endTime');

    const available = allSlots.filter(slot => {
      return !booked.some(b => {
        return slot >= b.startTime && slot < b.endTime;
      });
    });

    res.json({ slots: available });
  } catch (error) {
    console.error('Slots error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/public/book/:slug
// @desc    Client self-books an appointment
// @access  Public
router.post('/book/:slug', [
  body('serviceId').notEmpty().withMessage('Service is required'),
  body('date').isISO8601().withMessage('Valid date is required'),
  body('startTime').notEmpty().withMessage('Start time is required'),
  body('client.name').trim().notEmpty().withMessage('Your name is required'),
  body('client.email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const business = await Business.findOne({ slug: req.params.slug, isActive: true });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const service = await Service.findById(req.body.serviceId);
    if (!service || !service.isAvailable) return res.status(404).json({ message: 'Service not available' });

    const { date, startTime, client, notes } = req.body;

    // Calculate end time
    const [h, m] = startTime.split(':').map(Number);
    const start = new Date(date);
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + service.duration * 60000);
    const endTime = end.toTimeString().slice(0, 5);

    // Check conflict
    const conflict = await Appointment.findOne({
      business: business._id,
      date: new Date(date),
      status: { $in: ['pending', 'confirmed'] },
      $or: [
        { startTime: { $lt: endTime }, endTime: { $gt: startTime } }
      ]
    });
    if (conflict) return res.status(409).json({ message: 'That time slot is no longer available' });

    const appointment = await Appointment.create({
      business: business._id,
      service:  service._id,
      staff:    business.owner,
      client,
      date:     new Date(date),
      startTime,
      endTime,
      notes,
      status: 'pending',
      payment: { amount: service.price, status: 'pending', method: 'cash' }
    });

    // Send confirmation email to client
    if (client.email) {
      await sendEmailReminder(
        { ...appointment.toObject(), business, service },
        client.email
      ).catch(() => {}); // don't fail the response if email fails
    }

    res.status(201).json({
      message: 'Booking confirmed! You will receive a confirmation email shortly.',
      appointmentId: appointment._id
    });
  } catch (error) {
    console.error('Public book POST error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/public/receptionist/:slug
// @desc    Chat with AI receptionist
// @access  Public
router.post('/receptionist/:slug', [
  body('message').trim().notEmpty().withMessage('Message is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const business = await Business.findOne({ slug: req.params.slug, isActive: true })
      .select('-owner -staff -settings -__v')
      .lean();

    if (!business) return res.status(404).json({ message: 'Business not found' });

    const services = await Service.find({ business: business._id, isAvailable: true })
      .select('name description duration price currency')
      .lean();

    const businessContext = { ...business, services };

    const { response, collectedData } = await generateReceptionistResponse(req.body.message, businessContext, req.body.history || []);

    res.json({ response, collectedData, business: { name: business.name } });
  } catch (error) {
    console.error('Receptionist error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
