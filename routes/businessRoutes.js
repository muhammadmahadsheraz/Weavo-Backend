const express = require('express');
const { body, validationResult } = require('express-validator');
const Business = require('../models/Business');
const Service  = require('../models/Service');

const router = express.Router();

// @route   POST /api/businesses
// @desc    Create a new business
// @access  Private
router.post('/', [
  body('name').trim().notEmpty().withMessage('Business name is required'),
  body('address.street').trim().notEmpty().withMessage('Street address is required'),
  body('address.city').trim().notEmpty().withMessage('City is required'),
  body('address.state').trim().notEmpty().withMessage('State is required'),
  body('address.zipCode').trim().notEmpty().withMessage('Zip code is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const businessData = {
      ...req.body,
      owner: req.user.id
    };

    const business = new Business(businessData);
    await business.save();

    res.status(201).json(business);
  } catch (error) {
    console.error('Create business error:', error);
    res.status(500).json({ message: 'Server error creating business' });
  }
});

// @route   GET /api/businesses
// @desc    Get all businesses for current user
// @access  Private
router.get('/', async (req, res) => {
  try {
    let businesses = await Business.find({ owner: req.user.id })
      .populate('services')
      .populate('staff')
      .lean();

    // Backfill slugs and sync service arrays for businesses that are missing them
    let needsSave = false;
    const updates = businesses.map(async (b) => {
      const ops = {};

      // Slug missing — generate one
      if (!b.slug) {
        ops.slug = b.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '') +
          '-' + Math.random().toString(36).slice(2, 6);
        needsSave = true;
      }

      // Service array empty — pull from Service collection to sync
      if (!b.services || b.services.length === 0) {
        const svcDocs = await Service.find({ business: b._id }).select('_id');
        if (svcDocs.length > 0) {
          ops.services = svcDocs.map(s => s._id);
          needsSave = true;
        }
      }

      if (Object.keys(ops).length > 0) {
        await Business.findByIdAndUpdate(b._id, ops);
      }
    });

    await Promise.all(updates);

    // Re-fetch only if we made changes
    if (needsSave) {
      businesses = await Business.find({ owner: req.user.id })
        .populate('services')
        .populate('staff')
        .lean();
    }

    res.json(businesses);
  } catch (error) {
    console.error('Get businesses error:', error);
    res.status(500).json({ message: 'Server error getting businesses' });
  }
});

// @route   GET /api/businesses/:id
// @desc    Get business by ID
// @access  Private
router.get('/:id', async (req, res) => {
  try {
    const business = await Business.findById(req.params.id)
      .populate('services')
      .populate('staff');
    
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    res.json(business);
  } catch (error) {
    console.error('Get business error:', error);
    res.status(500).json({ message: 'Server error getting business' });
  }
});

// @route   PUT /api/businesses/:id
// @desc    Update business
// @access  Private
router.put('/:id', [
  body('name').trim().notEmpty().withMessage('Business name is required'),
  body('address.street').trim().notEmpty().withMessage('Street address is required'),
  body('address.city').trim().notEmpty().withMessage('City is required'),
  body('address.state').trim().notEmpty().withMessage('State is required'),
  body('address.zipCode').trim().notEmpty().withMessage('Zip code is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let business = await Business.findById(req.params.id);
    
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    // Check ownership
    if (business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to update this business' });
    }

    business = await Business.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    res.json(business);
  } catch (error) {
    console.error('Update business error:', error);
    res.status(500).json({ message: 'Server error updating business' });
  }
});

// @route   DELETE /api/businesses/:id
// @desc    Delete business
// @access  Private
router.delete('/:id', async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    
    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    // Check ownership
    if (business.owner.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to delete this business' });
    }

    await Business.findByIdAndDelete(req.params.id);
    res.json({ message: 'Business deleted successfully' });
  } catch (error) {
    console.error('Delete business error:', error);
    res.status(500).json({ message: 'Server error deleting business' });
  }
});

module.exports = router;