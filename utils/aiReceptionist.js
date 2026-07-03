const generateReceptionistResponse = async (userMessage, businessContext) => {
  try {
    if (process.env.GROQ_API_KEY) {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: 'https://api.groq.com/openai/v1',
      });

      const prompt = `
        You are an AI receptionist for ${businessContext.name}.
        
        Business Details:
        - Name: ${businessContext.name}
        - Services: ${businessContext.services?.map(s => s.name).join(', ') || 'Various services'}
        - Working Hours: ${JSON.stringify(businessContext.workingHours)}
        - Address: ${businessContext.address?.street}, ${businessContext.address?.city}
        
        User Message: "${userMessage}"
        
        Respond as a friendly, professional receptionist. If the user wants to book an appointment, ask for:
        1. Service they want
        2. Preferred date and time
        3. Contact information (name, email, phone)
        
        Keep responses concise and helpful.
      `;

      const completion = await openai.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        model: 'llama-3.3-70b-versatile',
      });

      return completion.choices[0]?.message?.content || "I'm having trouble processing your request.";
    }

    return generateFallbackResponse(userMessage, businessContext);

  } catch (error) {
    console.error('AI receptionist error:', error);
    return generateFallbackResponse(userMessage, businessContext);
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
  // Simple rule-based extraction (100% free, no API needed)
  const message = userMessage.toLowerCase();
  
  const result = {
    hasBookingIntent: message.includes('book') || message.includes('appointment') || message.includes('schedule')
  };

  // Extract date (simple pattern)
  const dateMatch = userMessage.match(/\b(202\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (dateMatch) {
    result.date = dateMatch[0];
  }

  // Extract time (simple pattern)
  const timeMatch = userMessage.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (timeMatch) {
    result.time = `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`;
  }

  // Extract phone
  const phoneMatch = userMessage.match(/\+?[1-9]\d{1,14}/);
  if (phoneMatch) {
    result.clientPhone = phoneMatch[0];
  }

  return result;
};

module.exports = {
  generateReceptionistResponse,
  extractBookingIntent
};