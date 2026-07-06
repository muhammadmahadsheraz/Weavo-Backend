const express = require('express');
const { body, validationResult } = require('express-validator');
const Appointment = require('../models/Appointment');
const Business = require('../models/Business');
const Service = require('../models/Service');
const User = require('../models/User');
const { sendEmailReminder, sendTelegramReminder } = require('../utils/notifications');
const { syncCreateAppointment, syncUpdateAppointment, syncDeleteAppointment, sendGmailReminder } = require('../utils/calendarSync');

const router = express.Router();

// @route   POST /api/appointments
// @desc    Create a new appointment
// @access  Private
router.post('/', [
  body('business').notEmpty().withMessage('Business ID is required'),
  body('service').notEmpty().withMessage('Service ID is required'),
  body('date').isISO8601().withMessage('Valid date is required'),
  body('startTime').notEmpty().withMessage('Start time is required'),
  body('client.name').trim().notEmpty().withMessage('Client name is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { business, service, date, startTime, client, notes, staff } = req.body;

    // Check if business exists and belongs to user
    const businessDoc = await Business.findById(business);
    if (!businessDoc) {
      return res.status(404).json({ message: 'Business not found' });
    }

    if (businessDoc.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to create appointment for this business' });
    }

    // Check if service exists
    const serviceDoc = await Service.findById(service);
    if (!serviceDoc) {
      return res.status(404).json({ message: 'Service not found' });
    }

    // Calculate end time
    const [hours, minutes] = startTime.split(':').map(Number);
    const startDate = new Date(date);
    startDate.setHours(hours, minutes, 0, 0);
    
    const duration = serviceDoc.duration;
    const endDate = new Date(startDate.getTime() + duration * 60000);
    const endTime = endDate.toTimeString().slice(0, 5);

    // Check for time conflicts
    const existingAppointment = await Appointment.findOne({
      business,
      staff: staff || businessDoc.owner,
      date,
      $or: [
        { startTime: { $lt: endTime }, endTime: { $gt: startTime } },
        { startTime: { $gte: startTime, $lt: endTime } }
      ]
    });

    if (existingAppointment) {
      return res.status(400).json({ message: 'Time slot is already booked' });
    }

    const appointment = new Appointment({
      business,
      service,
      staff: staff || businessDoc.owner,
      client,
      date,
      startTime,
      endTime,
      notes,
      status: 'pending',
      payment: {
        amount: serviceDoc.price,
        status: 'pending',
        method: req.body.paymentMethod || 'cash'
      }
    });

    await appointment.save();

    // Sync to connected calendars (fire-and-forget)
    syncCreateAppointment(appointment, businessDoc, serviceDoc)
      .then(({ results }) => {
        if (results.length > 0) {
          Appointment.findByIdAndUpdate(appointment._id, {
            $push: { calendarEvents: { $each: results } }
          }).catch(() => {});
        }
      })
      .catch(() => {});

    res.status(201).json(appointment);
  } catch (error) {
    console.error('Create appointment error:', error);
    res.status(500).json({ message: 'Server error creating appointment' });
  }
});

// @route   GET /api/appointments
// @desc    Get appointments for current user's businesses
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { status, date, businessId } = req.query;

    // First get all businesses owned by the user
    const businesses = await Business.find({ owner: req.user.id }).select('_id');
    const businessIds = businesses.map(b => b._id);

    let query = { business: { $in: businessIds } };

    if (status) query.status = status;
    if (date) query.date = date;
    if (businessId) query.business = businessId;

    const appointments = await Appointment.find(query)
      .populate('business', 'name email phone')
      .populate('service', 'name price currency duration')
      .populate('staff', 'name email')
      .sort({ date: -1, startTime: -1 });

    res.json(appointments);
  } catch (error) {
    console.error('Get appointments error:', error);
    res.status(500).json({ message: 'Server error getting appointments' });
  }
});

// @route   GET /api/appointments/:id
// @desc    Get appointment by ID
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id)
      .populate('business')
      .populate('service')
      .populate('staff');

    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Check authorization
    const business = await Business.findById(appointment.business);
    if (business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to view this appointment' });
    }

    res.json(appointment);
  } catch (error) {
    console.error('Get appointment error:', error);
    res.status(500).json({ message: 'Server error getting appointment' });
  }
});

// @route   PUT /api/appointments/:id/status
// @desc    Update appointment status
// @access  Private
router.put('/:id/status', [
  body('status').isIn(['pending', 'confirmed', 'cancelled', 'completed', 'no-show']).withMessage('Invalid status')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let appointment = await Appointment.findById(req.params.id);
    
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Check authorization
    const business = await Business.findById(appointment.business);
    if (business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this appointment' });
    }

    const prevStatus = appointment.status;
    appointment.status = req.body.status;

    // Auto-mark payment as paid when appointment is completed
    if (req.body.status === 'completed') {
      appointment.payment.status = 'paid';
    }

    await appointment.save();

    // Sync status change to connected calendars
    if (prevStatus !== appointment.status) {
      Appointment.findById(appointment._id)
        .populate('business')
        .populate('service')
        .then(async populated => {
          if (appointment.status === 'cancelled') {
            syncDeleteAppointment(populated).catch(() => {});
          } else if (populated.calendarEvents?.length > 0) {
            syncUpdateAppointment(populated, populated.business, populated.service).catch(() => {});
          } else {
            const { results } = await syncCreateAppointment(populated, populated.business, populated.service);
            if (results.length > 0) {
              await Appointment.findByIdAndUpdate(populated._id, {
                $push: { calendarEvents: { $each: results } }
              });
            }
          }
        })
        .catch(() => {});
    }

    // Send confirmation email via business owner's connected Google, fallback to SMTP
    if (req.body.status === 'confirmed' && appointment.client?.email) {
      const populated = await Appointment.findById(appointment._id)
        .populate('business', 'name address phone')
        .populate('service', 'name duration price currency');
      sendGmailReminder(populated, appointment.client.email)
        .catch(err => {
          console.error('sendGmailReminder failed, falling back to SMTP:', err.message);
          sendEmailReminder(populated, appointment.client.email).catch(() => {});
        });
    }

    res.json(appointment);
  } catch (error) {
    console.error('Update appointment status error:', error);
    res.status(500).json({ message: 'Server error updating appointment status' });
  }
});

// @route   PUT /api/appointments/:id/reschedule
// @desc    Reschedule an appointment (update date/time/service)
// @access  Private
router.put('/:id/reschedule', [
  body('date').isISO8601().withMessage('Valid date is required'),
  body('startTime').notEmpty().withMessage('Start time is required'),
  body('service').optional().notEmpty().withMessage('Service ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let appointment = await Appointment.findById(req.params.id);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });

    const business = await Business.findById(appointment.business);
    if (business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    const serviceId = req.body.service || appointment.service;
    const serviceDoc = await Service.findById(serviceId);
    if (!serviceDoc) return res.status(404).json({ message: 'Service not found' });

    const [hours, minutes] = req.body.startTime.split(':').map(Number);
    const startDate = new Date(req.body.date);
    startDate.setHours(hours, minutes, 0, 0);
    const endDate = new Date(startDate.getTime() + serviceDoc.duration * 60000);
    const endTime = endDate.toTimeString().slice(0, 5);

    const conflict = await Appointment.findOne({
      _id: { $ne: appointment._id },
      business: appointment.business,
      staff: appointment.staff || business.owner,
      date: new Date(req.body.date),
      status: { $in: ['pending', 'confirmed'] },
      $or: [
        { startTime: { $lt: endTime }, endTime: { $gt: req.body.startTime } }
      ]
    });

    if (conflict) return res.status(400).json({ message: 'Time slot is already booked' });

    appointment.date = new Date(req.body.date);
    appointment.startTime = req.body.startTime;
    appointment.endTime = endTime;
    if (req.body.service) appointment.service = req.body.service;
    if (req.body.notes !== undefined) appointment.notes = req.body.notes;

    await appointment.save();

    Appointment.findById(appointment._id)
      .populate('business')
      .populate('service')
      .then(populated => syncUpdateAppointment(populated, populated.business, populated.service).catch(() => {}))
      .catch(() => {});

    res.json(appointment);
  } catch (error) {
    console.error('Reschedule error:', error);
    res.status(500).json({ message: 'Server error rescheduling appointment' });
  }
});

// @route   DELETE /api/appointments/:id
// @desc    Cancel appointment
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);
    
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    // Check authorization
    const business = await Business.findById(appointment.business);
    if (business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this appointment' });
    }

    // Delete calendar events before removing appointment
    Appointment.findById(appointment._id)
      .populate('business')
      .populate('service')
      .then(populated => syncDeleteAppointment(populated).catch(() => {}))
      .catch(() => {});

    await Appointment.findByIdAndDelete(req.params.id);
    res.json({ message: 'Appointment cancelled successfully' });
  } catch (error) {
    console.error('Delete appointment error:', error);
    res.status(500).json({ message: 'Server error deleting appointment' });
  }
});

module.exports = router;