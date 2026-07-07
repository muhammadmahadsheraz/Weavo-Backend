const express = require('express');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const Business = require('../models/Business');
const Service  = require('../models/Service');
const Appointment = require('../models/Appointment');
const Otp = require('../models/Otp');
const { sendEmail } = require('../utils/notifications');
const { generateReceptionistResponse } = require('../utils/aiReceptionist');

const router = express.Router();

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// OTP verification middleware
async function requireOtpToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ message: 'OTP verification required' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.type !== 'otp') throw new Error('Invalid token type');
    req.verifiedEmail = decoded.email;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired OTP token' });
  }
}

// @route   GET /api/public/businesses
// @desc    List all active businesses (directory)
// @access  Public
router.get('/businesses', async (req, res) => {
  try {
    const { search } = req.query;
    const filter = { isActive: true };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { 'address.city': { $regex: search, $options: 'i' } },
        { 'address.state': { $regex: search, $options: 'i' } },
      ];
    }
    const businesses = await Business.find(filter)
      .select('name address.city address.state slug phone')
      .sort({ name: 1 })
      .lean();

    res.json({ businesses });
  } catch (error) {
    console.error('Businesses directory error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/public/send-otp
// @desc    Send OTP code to email
// @access  Public
router.post('/send-otp', [
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const email = req.body.email.toLowerCase();
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // Rate limit: max 3 OTPs per email per hour
    const recentCount = await Otp.countDocuments({
      email,
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
    });
    if (recentCount >= 3)
      return res.status(429).json({ message: 'Too many requests. Try again later.' });

    await Otp.create({ email, code, expiresAt });

    await sendEmail(
      email,
      'Your Weavo verification code',
      `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px;">
        <h2 style="margin:0 0 16px;color:#111;font-size:20px;">Verification Code</h2>
        <p style="margin:0 0 20px;color:#555;font-size:14px;">Use this code to manage your bookings:</p>
        <div style="text-align:center;padding:16px;background:#fff;border-radius:8px;font-size:32px;font-weight:700;letter-spacing:6px;color:#7C3AED;">${code}</div>
        <p style="margin:20px 0 0;color:#888;font-size:12px;">Code expires in 10 minutes.</p>
      </div>`
    );

    res.json({ message: 'Verification code sent to your email' });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/public/verify-otp
// @desc    Verify OTP and return short-lived JWT
// @access  Public
router.post('/verify-otp', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('code').notEmpty().withMessage('Code is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const email = req.body.email.toLowerCase();
    const code = req.body.code.trim();

    const otp = await Otp.findOne({ email, code, expiresAt: { $gte: new Date() }, verified: false })
      .sort({ createdAt: -1 });

    if (!otp) {
      // Increment attempts on the latest OTP
      const latest = await Otp.findOne({ email, verified: false }).sort({ createdAt: -1 });
      if (latest) {
        latest.attempts += 1;
        await latest.save();
        if (latest.attempts >= 3) {
          return res.status(429).json({ message: 'Too many incorrect attempts. Request a new code.' });
        }
      }
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    otp.verified = true;
    await otp.save();

    const token = jwt.sign(
      { email, type: 'otp' },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({ token, email });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

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
    if (!errors.isEmpty()) {
      console.error('Booking 400 — validation errors:', JSON.stringify(errors.array()));
      console.error('Booking 400 — body:', JSON.stringify(req.body));
      return res.status(400).json({ errors: errors.array() });
    }

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

    res.status(201).json({
      message: 'Booking request submitted! You will receive a confirmation email once the business confirms.',
      appointmentId: appointment._id
    });
  } catch (error) {
    console.error('Public book POST error:', error);
    res.status(500).json({ message: error.message || 'Server error' });
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

// @route   GET /api/public/book/:slug/lookup
// @desc    Lookup a customer's upcoming bookings by email (requires OTP JWT)
// @access  Public (with OTP)
router.get('/book/:slug/lookup', requireOtpToken, async (req, res) => {
  try {
    const business = await Business.findOne({ slug: req.params.slug, isActive: true });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const appointments = await Appointment.find({
      business: business._id,
      'client.email': req.verifiedEmail,
      status: { $in: ['pending', 'confirmed'] },
      date: { $gte: startOfToday }
    })
      .populate('service', 'name duration price currency')
      .select('date startTime endTime status service client')
      .sort({ date: 1 })
      .lean();

    res.json({ appointments });
  } catch (error) {
    console.error('Lookup error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/public/book/:slug/cancel
// @desc    Customer cancels their own appointment
// @access  Public
router.post('/book/:slug/cancel', [
  body('appointmentId').notEmpty().withMessage('Appointment ID is required'),
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const business = await Business.findOne({ slug: req.params.slug, isActive: true });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const appointment = await Appointment.findById(req.body.appointmentId);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

    if (appointment.business.toString() !== business._id.toString())
      return res.status(400).json({ message: 'Appointment does not belong to this business' });

    if (appointment.client.email.toLowerCase() !== req.body.email.toLowerCase())
      return res.status(403).json({ message: 'Email does not match this appointment' });

    if (appointment.status === 'cancelled')
      return res.status(400).json({ message: 'Appointment is already cancelled' });

    if (appointment.status === 'completed')
      return res.status(400).json({ message: 'Cannot cancel a completed appointment' });

    appointment.status = 'cancelled';
    await appointment.save();

    res.json({ message: 'Appointment cancelled successfully' });
  } catch (error) {
    console.error('Cancel error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/public/book/:slug/reschedule
// @desc    Customer reschedules their own appointment
// @access  Public
router.post('/book/:slug/reschedule', [
  body('appointmentId').notEmpty().withMessage('Appointment ID is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('date').isISO8601().withMessage('Valid date is required'),
  body('startTime').notEmpty().withMessage('Start time is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const business = await Business.findOne({ slug: req.params.slug, isActive: true });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const appointment = await Appointment.findById(req.body.appointmentId).populate('service');
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

    if (appointment.business.toString() !== business._id.toString())
      return res.status(400).json({ message: 'Appointment does not belong to this business' });

    if (appointment.client.email.toLowerCase() !== req.body.email.toLowerCase())
      return res.status(403).json({ message: 'Email does not match this appointment' });

    if (appointment.status === 'cancelled')
      return res.status(400).json({ message: 'Cannot reschedule a cancelled appointment' });

    if (appointment.status === 'completed')
      return res.status(400).json({ message: 'Cannot reschedule a completed appointment' });

    const serviceDoc = appointment.service;

    const [hours, minutes] = req.body.startTime.split(':').map(Number);
    const startDate = new Date(req.body.date);
    startDate.setHours(hours, minutes, 0, 0);
    const endDate = new Date(startDate.getTime() + serviceDoc.duration * 60000);
    const endTime = endDate.toTimeString().slice(0, 5);

    const conflict = await Appointment.findOne({
      _id: { $ne: appointment._id },
      business: business._id,
      staff: appointment.staff || business.owner,
      date: new Date(req.body.date),
      status: { $in: ['pending', 'confirmed'] },
      $or: [
        { startTime: { $lt: endTime }, endTime: { $gt: req.body.startTime } }
      ]
    });

    if (conflict) return res.status(409).json({ message: 'That time slot is no longer available' });

    appointment.date = new Date(req.body.date);
    appointment.startTime = req.body.startTime;
    appointment.endTime = endTime;
    await appointment.save();

    res.json({ message: 'Appointment rescheduled successfully', appointment });
  } catch (error) {
    console.error('Reschedule error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
