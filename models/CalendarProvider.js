const mongoose = require('mongoose');

const calendarProviderSchema = new mongoose.Schema({
  business: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  provider: {
    type: String,
    enum: ['google', 'outlook', 'apple'],
    required: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  accessToken: {
    type: String
  },
  refreshToken: {
    type: String
  },
  tokenExpiry: {
    type: Date
  },
  applePassword: {
    type: String
  },
  isConnected: {
    type: Boolean,
    default: false
  },
  calendars: [{
    id: { type: String },
    name: { type: String },
    isPrimary: { type: Boolean, default: false }
  }],
  selectedCalendarId: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

calendarProviderSchema.index({ business: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('CalendarProvider', calendarProviderSchema);
