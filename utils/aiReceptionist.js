const generateReceptionistResponse = async (userMessage, businessContext, conversationHistory = []) => {
  try {
    if (process.env.GROQ_API_KEY) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
      });

      const servicesList = businessContext.services?.map(s => s.name).join(', ') || 'Various services';

      const systemPrompt = `You are an AI receptionist for ${businessContext.name}.

Business Details:
- Name: ${businessContext.name}
- Services available: ${servicesList}
- Working Hours: ${JSON.stringify(businessContext.workingHours)}
- Address: ${businessContext.address?.street}, ${businessContext.address?.city}

You help customers with three things:
1. BOOKING a new appointment — collect details one at a time conversationally.
2. CANCELLING an existing appointment — ask for their email, then tell them you'll look up their bookings.
3. RESCHEDULING an existing appointment — ask for their email, then tell them you'll look up their bookings.

At the END of your response, include a machine-readable block using this format:
[DATA]{"action":"book","service":null,"date":null,"time":null,"name":null,"email":null,"phone":null}[/DATA]

Available actions: "book" (new booking), "cancel" (wants to cancel), "reschedule" (wants to reschedule).
The "service" value must match exactly one of the available service names listed above, or be null.
Only fill in fields the user has explicitly stated. Set to null if not yet provided.

Your conversational response should be natural and friendly. If booking, ask for missing info naturally. If cancelling or rescheduling, ask for their email to look up appointments.`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory.map(m => ({ role: m.role, content: m.text })),
        { role: 'user', content: userMessage },
      ];

      const completion = await openai.chat.completions.create({
        messages,
        model: 'llama-3.3-70b-versatile',
      });

      const fullContent = completion.choices[0]?.message?.content || '';

      const dataMatch = fullContent.match(/\[DATA\]([\s\S]*?)\[\/DATA\]/);
      let collectedData = { action: 'book', service: null, date: null, time: null, name: null, email: null, phone: null };
      if (dataMatch) {
        try {
          collectedData = { ...collectedData, ...JSON.parse(dataMatch[1]) };
        } catch {}
      }

      const response = fullContent.replace(/\[DATA\][\s\S]*?\[\/DATA\]/, '').trim();

      return { response, collectedData };
    }

    return {
      response: generateFallbackResponse(userMessage, businessContext),
      collectedData: { action: 'book', service: null, date: null, time: null, name: null, email: null, phone: null },
    };
  } catch (error) {
    console.error('=== AI RECEPTIONIST ERROR ===');
    console.error('Message:', error.message);
    console.error('Status:', error.status);
    if (error.response) {
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      console.error('Response status:', error.response.status);
    }
    if (error.code) console.error('Code:', error.code);
    console.error('Stack:', error.stack);
    return {
      response: generateFallbackResponse(userMessage, businessContext),
      collectedData: { action: 'book', service: null, date: null, time: null, name: null, email: null, phone: null },
    };
  }
};

const generateFallbackResponse = (userMessage, businessContext) => {
  const message = userMessage.toLowerCase();

  if (message.includes('cancel') || message.includes('cancel') || message.includes('cancel')) {
    return `I can help you cancel an appointment at ${businessContext.name}!

Please provide the email address you used when booking, and I'll look up your appointments.`;
  }

  if (message.includes('reschedule') || message.includes('change') || message.includes('move')) {
    return `I can help you reschedule an appointment at ${businessContext.name}!

Please provide the email address you used when booking, and I'll look up your appointments to find one to reschedule.`;
  }

  if (message.includes('book') || message.includes('appointment') || message.includes('schedule')) {
    return `I can help you book an appointment at ${businessContext.name}!

Please provide:
1. Which service you'd like
2. Your preferred date and time
3. Your name, email, and phone number

Would you like to see our available services?`;
  }

  if (message.includes('service') || message.includes('price') || message.includes('cost')) {
    const services = businessContext.services?.map(s => `${s.name} - $${s.price}`).join('\n') || 'Various services available';
    return `Our services:
${services}

Would you like to book an appointment?`;
  }

  if (message.includes('hours') || message.includes('time') || message.includes('open')) {
    const hours = businessContext.workingHours;
    const openDays = Object.entries(hours)
      .filter(([_, h]) => h.isOpen)
      .map(([day, h]) => `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.open} - ${h.close}`)
      .join('\n');

    return `We're open:
${openDays}

Would you like to book an appointment?`;
  }

  if (message.includes('manage') || message.includes('lookup') || message.includes('my booking') || message.includes('my appointment')) {
    return `I can help you manage your existing booking!

Please provide the email address you used when booking, and I'll look up your appointments.`;
  }

  if (message.includes('hello') || message.includes('hi') || message.includes('hey')) {
    return `Hello! I'm the AI receptionist for ${businessContext.name}.

I can help you book a new appointment, cancel an existing one, or reschedule. What would you like to do?`;
  }

  return `Thank you for your message!

I'm an AI assistant for ${businessContext.name}.
I can help you book appointments, cancel or reschedule existing ones, check our services, or answer questions about our hours.

What would you like to do?`;
};

const extractBookingIntent = async (userMessage) => {
  const message = userMessage.toLowerCase();

  const result = {
    hasBookingIntent: message.includes('book') || message.includes('appointment') || message.includes('schedule'),
  };

  const dateMatch = userMessage.match(/\b(202\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (dateMatch) result.date = dateMatch[0];

  const timeMatch = userMessage.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (timeMatch) result.time = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;

  const phoneMatch = userMessage.match(/\+?[1-9]\d{1,14}/);
  if (phoneMatch) result.clientPhone = phoneMatch[0];

  return result;
};

module.exports = {
  generateReceptionistResponse,
  extractBookingIntent,
};
