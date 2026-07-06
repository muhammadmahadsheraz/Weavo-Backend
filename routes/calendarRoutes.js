const express = require('express');
const { body, validationResult } = require('express-validator');
const Business = require('../models/Business');
const CalendarProvider = require('../models/CalendarProvider');
const { protect } = require('../middleware/auth');
const {
  getGoogleAuthUrl,
  handleGoogleCallback,
  getOutlookAuthUrl,
  handleOutlookCallback,
  connectAppleCalendar
} = require('../utils/calendarSync');

const router = express.Router();

async function verifyBusinessOwner(req, businessId) {
  const business = await Business.findById(businessId);
  if (!business) return { error: 'Business not found', status: 404 };
  if (business.owner.toString() !== req.user.id) return { error: 'Not authorized', status: 403 };
  return { business };
}

// @route   GET /api/calendar/providers
// @desc    Get calendar providers for user's businesses
// @access  Private
router.get('/providers', protect, async (req, res) => {
  try {
    const businesses = await Business.find({ owner: req.user.id }).select('_id name');
    const businessIds = businesses.map(b => b._id);

    const providers = await CalendarProvider.find({ business: { $in: businessIds } })
      .select('-accessToken -refreshToken -applePassword')
      .populate('business', 'name')
      .lean();

    const result = businesses.map(b => ({
      business: { _id: b._id, name: b.name },
      providers: {
        google: providers.find(p => p.business?._id?.toString() === b._id.toString() && p.provider === 'google') || null,
        outlook: providers.find(p => p.business?._id?.toString() === b._id.toString() && p.provider === 'outlook') || null,
        apple: providers.find(p => p.business?._id?.toString() === b._id.toString() && p.provider === 'apple') || null
      }
    }));

    res.json(result);
  } catch (error) {
    console.error('Get providers error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   POST /api/calendar/google/auth
// @desc    Get Google OAuth URL
// @access  Private
router.post('/google/auth', protect, [
  body('businessId').notEmpty().withMessage('Business ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { error, status } = await verifyBusinessOwner(req, req.body.businessId);
    if (error) return res.status(status).json({ message: error });

    const url = getGoogleAuthUrl();
    res.json({ url, state: req.body.businessId });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/calendar/google/callback
// @desc    Handle Google OAuth callback
// @access  Public (redirect-based OAuth)
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).json({ message: 'Missing code or state' });

    await handleGoogleCallback(code, state);

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?calendar=connected`);
  } catch (error) {
    console.error('Google callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?calendar=error`);
  }
});

// @route   POST /api/calendar/outlook/auth
// @desc    Get Outlook OAuth URL
// @access  Private
router.post('/outlook/auth', protect, [
  body('businessId').notEmpty().withMessage('Business ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { error, status } = await verifyBusinessOwner(req, req.body.businessId);
    if (error) return res.status(status).json({ message: error });

    const url = getOutlookAuthUrl();
    res.json({ url, state: req.body.businessId });
  } catch (error) {
    console.error('Outlook auth error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// @route   GET /api/calendar/outlook/callback
// @desc    Handle Outlook OAuth callback
// @access  Public (redirect-based OAuth)
router.get('/outlook/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).json({ message: 'Missing code or state' });

    await handleOutlookCallback(code, state);

    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?calendar=connected`);
  } catch (error) {
    console.error('Outlook callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?calendar=error`);
  }
});

// @route   POST /api/calendar/apple/connect
// @desc    Connect Apple Calendar (CalDAV)
// @access  Private
router.post('/apple/connect', protect, [
  body('businessId').notEmpty().withMessage('Business ID is required'),
  body('email').isEmail().withMessage('Valid Apple ID email is required'),
  body('password').notEmpty().withMessage('App-specific password is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { error, status } = await verifyBusinessOwner(req, req.body.businessId);
    if (error) return res.status(status).json({ message: error });

    await connectAppleCalendar(req.body.businessId, req.body.email, req.body.password);

    res.json({ message: 'Apple Calendar connected successfully' });
  } catch (error) {
    console.error('Apple connect error:', error);
    res.status(500).json({ message: error.message || 'Failed to connect Apple Calendar' });
  }
});

// @route   DELETE /api/calendar/:provider/disconnect
// @desc    Disconnect a calendar provider
// @access  Private
router.delete('/:provider/disconnect', protect, [
  body('businessId').notEmpty().withMessage('Business ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { provider } = req.params;
    if (!['google', 'outlook', 'apple'].includes(provider)) {
      return res.status(400).json({ message: 'Invalid provider' });
    }

    const { error, status } = await verifyBusinessOwner(req, req.body.businessId);
    if (error) return res.status(status).json({ message: error });

    await CalendarProvider.findOneAndDelete({ business: req.body.businessId, provider });

    res.json({ message: `${provider} calendar disconnected successfully` });
  } catch (error) {
    console.error('Disconnect error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
