const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Business = require('../models/Business');

const router = express.Router();

// @route   PUT /api/users
// @desc    Update current user
// @access  Private
router.put('/', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const user = await User.findByIdAndUpdate(
      req.user.id,
      req.body,
      { new: true, runValidators: true }
    ).select('-password');

    res.json(user);
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ message: 'Server error updating user' });
  }
});

// @route   POST /api/users/avatar
// @desc    Upload avatar
// @access  Private
router.post('/avatar', async (req, res) => {
  try {
    const { avatar } = req.body;

    const user = await User.findById(req.user.id);
    user.avatar = avatar;
    await user.save();

    res.json({ avatar: user.avatar });
  } catch (error) {
    console.error('Upload avatar error:', error);
    res.status(500).json({ message: 'Server error uploading avatar' });
  }
});

// @route   POST /api/users/businesses/:businessId
// @desc    Add business to user
// @access  Private
router.post('/businesses/:businessId', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const business = await Business.findById(req.params.businessId);

    if (!business) {
      return res.status(404).json({ message: 'Business not found' });
    }

    if (!user.businesses.includes(business._id)) {
      user.businesses.push(business._id);
      await user.save();
    }

    res.json(user);
  } catch (error) {
    console.error('Add business to user error:', error);
    res.status(500).json({ message: 'Server error adding business' });
  }
});

module.exports = router;