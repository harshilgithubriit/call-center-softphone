const mongoose = require('mongoose');

const AgentSchema = new mongoose.Schema({
  userId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['agent', 'manager'],
    default: 'agent'
  },
  status: {
    type: String,
    enum: ['Available', 'On-Call', 'Break', 'Wrap-Up', 'Offline'],
    default: 'Offline'
  },
  lastStatusChange: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Agent', AgentSchema);
