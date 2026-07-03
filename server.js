require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const app = express();

// CORS - must be before any routes
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL]
  : ['http://localhost:3000'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to DB before any routes (critical for serverless)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB connection failed:', err.message);
    res.status(500).json({ message: 'Database connection error' });
  }
});

// Routes
const authRoutes    = require('./routes/authRoutes');
const businessRoutes = require('./routes/businessRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const serviceRoutes  = require('./routes/serviceRoutes');
const userRoutes     = require('./routes/userRoutes');
const staffRoutes    = require('./routes/staffRoutes');
const publicRoutes   = require('./routes/publicRoutes');
const { protect }    = require('./middleware/auth');

app.use('/api/auth',         authRoutes);
app.use('/api/public',       publicRoutes);           // no auth — public booking
app.use('/api/businesses',   protect, businessRoutes);
app.use('/api/appointments', protect, appointmentRoutes);
app.use('/api/services',     protect, serviceRoutes);
app.use('/api/users',        protect, userRoutes);
app.use('/api/staff',        protect, staffRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'AI Appointment Booking API is running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Server error' });
});

// Only listen in non-serverless environments
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;