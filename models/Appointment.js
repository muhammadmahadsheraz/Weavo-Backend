const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  business: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  service: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  },
  staff: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  client: {
    name: {
      type: String,
      required: true,
      trim: true
    },
    email: {
      type: String,
      trim: true,
      lowercase: true
    },
    phone: {
      type: String,
      trim: true
    }
  },
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'cancelled', 'completed', 'no-show'],
    default: 'pending'
  },
  notes: {
    type: String,
    trim: true
  },
  payment: {
    status: {
      type: String,
      enum: ['pending', 'paid', 'refunded'],
      default: 'pending'
    },
    amount: {
      type: Number,
      required: true
    },
    method: {
      type: String,
      enum: ['cash', 'card', 'online', 'wallet'],
      default: 'cash'
    },
    transactionId: {
      type: String,
      trim: true
    }
  },
  calendarEvents: [{
    provider: {
      type: String,
      enum: ['google']
    },
    eventId: {
      type: String
    },
    calendarId: {
      type: String
    }
  }],
  reminders: [{
    type: {
      type: String,
      enum: ['email', 'whatsapp', 'sms'],
      required: true
    },
    sentAt: {
      type: Date
    },
    status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending'
    }
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Appointment', appointmentSchema);