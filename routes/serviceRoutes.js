const express = require('express');
const { body, validationResult } = require('express-validator');
const Service = require('../models/Service');
const Business = require('../models/Business');

const router = express.Router();

// @route   POST /api/services
// @desc    Create a new service
// @access  Private
router.post('/', [
  body('business').notEmpty().withMessage('Business ID is required'),
  body('name').trim().notEmpty().withMessage('Service name is required'),
  body('duration').isInt({ min: 15, max: 480 }).withMessage('Duration must be between 15 and 480 minutes'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const service = new Service(req.body);
    await service.save();

    // Keep Business.services array in sync
    await Business.findByIdAndUpdate(
      req.body.business,
      { $addToSet: { services: service._id } }
    );

    res.status(201).json(service);
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({ message: 'Server error creating service' });
  }
});

// @route   GET /api/services
// @desc    Get all services for the current user's businesses
// @access  Private
router.get('/', async (req, res) => {
  try {
    const { businessId } = req.query;
    let query = {};

    if (businessId) {
      query.business = businessId;
    } else {
      // Find all businesses owned by the user
      const businesses = await Business.find({ owner: req.user.id }).select('_id');
      const businessIds = businesses.map(b => b._id);
      query.business = { $in: businessIds };
    }

    const services = await Service.find(query).populate('business', 'name').populate('staff', 'name email');
    res.json(services);
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({ message: 'Server error getting services' });
  }
});

// @route   GET /api/services/:id
// @desc    Get service by ID
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id).populate('staff');
    
    if (!service) {
      return res.status(404).json({ message: 'Service not found' });
    }

    res.json(service);
  } catch (error) {
    console.error('Get service error:', error);
    res.status(500).json({ message: 'Server error getting service' });
  }
});

// @route   PUT /api/services/:id
// @desc    Update service
// @access  Private
router.put('/:id', [
  body('name').trim().notEmpty().withMessage('Service name is required'),
  body('duration').isInt({ min: 15, max: 480 }).withMessage('Duration must be between 15 and 480 minutes'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let service = await Service.findById(req.params.id);
    
    if (!service) {
      return res.status(404).json({ message: 'Service not found' });
    }

    // Check ownership via business
    const business = await Business.findById(service.business);
    if (!business || business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this service' });
    }

    service = await Service.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    res.json(service);
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ message: 'Server error updating service' });
  }
});

// @route   DELETE /api/services/:id
// @desc    Delete service
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    
    if (!service) {
      return res.status(404).json({ message: 'Service not found' });
    }

    // Check ownership via business
    const business = await Business.findById(service.business);
    if (!business || business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this service' });
    }

    await Service.findByIdAndDelete(req.params.id);

    // Remove from Business.services array
    await Business.findByIdAndUpdate(
      service.business,
      { $pull: { services: service._id } }
    );

    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ message: 'Server error deleting service' });
  }
});

module.exports = router;