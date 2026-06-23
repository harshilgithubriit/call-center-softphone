const mongoose = require('mongoose');

const CallLogSchema = new mongoose.Schema({
  callId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  callerId: {
    type: String,
    required: true
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    default: null
  },
  direction: {
    type: String,
    enum: ['Inbound', 'Outbound'],
    required: true
  },
  status: {
    type: String,
    enum: ['Answered', 'Missed', 'Busy', 'Abandoned'],
    required: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    default: null
  },
  durationInSeconds: {
    type: Number,
    default: 0
  },
  recordingUrl: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('CallLog', CallLogSchema);
