const express = require('express');
const { body, validationResult } = require('express-validator');
const Business = require('../models/Business');
const User     = require('../models/User');

const router = express.Router();

// @route   GET /api/staff/:businessId
// @desc    Get all staff for a business
// @access  Private
router.get('/:businessId', async (req, res) => {
  try {
    const business = await Business.findById(req.params.businessId).populate('staff', 'name email phone avatar');
    if (!business) return res.status(404).json({ message: 'Business not found' });
    if (business.owner.toString() !== req.user.id)
      return res.status(403).json({ message: 'Not authorized' });
    res.json(business.staff || []);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/staff/:businessId/invite
// @desc    Add staff member by email
// @access  Private
router.post('/:businessId/invite', [
  body('email').isEmail().withMessage('Valid email is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const business = await Business.findById(req.params.businessId);
    if (!business) return res.status(404).json({ message: 'Business not found' });
    if (business.owner.toString() !== req.user.id)
      return res.status(403).json({ message: 'Not authorized' });

    const staffUser = await User.findOne({ email: req.body.email });
    if (!staffUser) return res.status(404).json({ message: 'No user found with that email address' });

    if (business.staff.includes(staffUser._id))
      return res.status(400).json({ message: 'This person is already on your team' });

    business.staff.push(staffUser._id);
    await business.save();

    res.json({ message: `${staffUser.name} added to your team`, staff: staffUser });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   DELETE /api/staff/:businessId/:staffId
// @desc    Remove staff member
// @access  Private
router.delete('/:businessId/:staffId', async (req, res) => {
  try {
    const business = await Business.findById(req.params.businessId);
    if (!business) return res.status(404).json({ message: 'Business not found' });
    if (business.owner.toString() !== req.user.id)
      return res.status(403).json({ message: 'Not authorized' });

    business.staff = business.staff.filter(s => s.toString() !== req.params.staffId);
    await business.save();
    res.json({ message: 'Staff member removed' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
