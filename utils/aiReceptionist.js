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

Your job is to help customers book appointments by collecting details one at a time conversationally.

At the END of your response, include a machine-readable block listing any booking info the user has explicitly provided so far. Use this format:
[DATA]{"service":null,"date":null,"time":null,"name":null,"email":null,"phone":null}[/DATA]

Only fill in fields the user has explicitly stated. Set to null if not yet provided. The "service" value must match exactly one of the available service names listed above, or be null.

Your conversational response should be natural and friendly. If some info is still missing, ask for it naturally. If all info is provided, tell the user everything looks ready and they can confirm the booking.`;

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
      let collectedData = { service: null, date: null, time: null, name: null, email: null, phone: null };
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
      collectedData: { service: null, date: null, time: null, name: null, email: null, phone: null },
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
      collectedData: { service: null, date: null, time: null, name: null, email: null, phone: null },
    };
  }
};

const generateFallbackResponse = (userMessage, businessContext) => {
  const message = userMessage.toLowerCase();

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

  if (message.includes('hello') || message.includes('hi') || message.includes('hey')) {
    return `Hello! I'm the AI receptionist for ${businessContext.name}.

How can I help you today?`;
  }

  return `Thank you for your message!

I'm an AI assistant for ${businessContext.name}.
I can help you book appointments, check our services, or answer questions about our hours.

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
