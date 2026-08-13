const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const db = require('./db');

/**
 * Handle incoming WhatsApp messages through Gemini API & MCP Tool routing
 */
async function handleIncomingMessage(sessionId, phone, incomingText, socket, io) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    console.log('[AI Hub] GEMINI_API_KEY is not configured in .env. Skipping AI processing.');
    return;
  }

  // 1. Fetch all active MCP clients
  const activeMcps = await db.getMcpRegistries();
  const enabledMcps = activeMcps.filter(m => m.is_active === 1);

  // If no MCPs are registered or active, we can fallback to standard conversation or skip
  let systemInstruction = 'Anda adalah asisten AI yang sopan dan profesional.';
  let combinedTools = [];
  const functionMcpMap = new Map();

  // 2. Fetch and register tools from each active MCP client dynamically
  for (const mcp of enabledMcps) {
    console.log(`[AI Hub] Fetching dynamic tools from project: ${mcp.project_name} (${mcp.mcp_url})`);
    
    // Add custom instructions if defined
    if (mcp.system_instructions) {
      systemInstruction += `\n\nInstruksi Tambahan untuk proyek ${mcp.project_name}:\n${mcp.system_instructions}`;
    }

    try {
      const response = await axios.post(mcp.mcp_url, {
        method: 'tools/list'
      }, {
        headers: {
          'Authorization': `Bearer ${mcp.secret_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      const toolsList = response.data?.tools || response.data?.result?.tools || [];
      if (Array.isArray(toolsList)) {
        toolsList.forEach(tool => {
          // Track function mapping to trigger the right URL later
          functionMcpMap.set(tool.name, mcp);
          combinedTools.push({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          });
          console.log(`[AI Hub] Registered tool: ${tool.name} for project ${mcp.project_name}`);
        });
      }
    } catch (err) {
      console.error(`[AI Hub] Failed to load tools from ${mcp.project_name}:`, err.message);
    }
  }

  // 3. Initialize Gemini
  const genAI = new GoogleGenerativeAI(geminiApiKey);
  const modelOptions = {
    model: 'gemini-1.5-flash',
    systemInstruction: systemInstruction
  };

  // Only pass tools if we actually registered functions from MCP clients
  if (combinedTools.length > 0) {
    modelOptions.tools = [{
      functionDeclarations: combinedTools
    }];
  }

  const model = genAI.getGenerativeModel(modelOptions);
  
  // 4. Start Chat session with history
  // Retrieve previous chat history from DB to give Gemini context of the conversation
  const chatHistory = await db.getChatMessages(sessionId, phone);
  // Map last 10 messages for context
  const contents = chatHistory.slice(-10).map(msg => ({
    role: msg.from_me === 1 ? 'model' : 'user',
    parts: [{ text: msg.message }]
  }));

  // Append current message
  contents.push({
    role: 'user',
    parts: [{ text: incomingText }]
  });

  console.log(`[AI Hub] Invoking Gemini model for ${phone}...`);
  let result = await model.generateContent({
    contents
  });
  
  let response = result.response;

  // 5. Handle Function Calls (The Spoke Bridge)
  let functionCalls = response.functionCalls;
  while (functionCalls && functionCalls.length > 0) {
    const call = functionCalls[0];
    console.log(`[AI Hub] Gemini requested function call: ${call.name} with args:`, call.args);

    const targetMcp = functionMcpMap.get(call.name);
    if (!targetMcp) {
      console.warn(`[AI Hub] Requested function ${call.name} has no associated MCP server registered.`);
      break;
    }

    let toolResult;
    try {
      console.log(`[AI Hub] Forwarding function execution to: ${targetMcp.project_name} -> ${targetMcp.mcp_url}`);
      const mcpResponse = await axios.post(targetMcp.mcp_url, {
        method: 'tools/call',
        params: {
          name: call.name,
          arguments: call.args
        }
      }, {
        headers: {
          'Authorization': `Bearer ${targetMcp.secret_key}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      toolResult = mcpResponse.data?.result || mcpResponse.data || { success: true };
    } catch (err) {
      console.error(`[AI Hub] MCP Call failed for ${call.name}:`, err.message);
      toolResult = { error: `MCP Call failed: ${err.message}` };
    }

    console.log(`[AI Hub] Sending tool result back to Gemini:`, toolResult);
    
    // Feed the function execution result back to the model
    result = await model.generateContent({
      contents: [
        ...contents,
        {
          role: 'model',
          parts: [response.candidates[0].content.parts[0]]
        },
        {
          role: 'user',
          parts: [{
            functionResponse: {
              name: call.name,
              response: { result: toolResult }
            }
          }]
        }
      ]
    });

    response = result.response;
    functionCalls = response.functionCalls;
  }

  const finalReply = response.text;
  if (!finalReply) {
    console.warn('[AI Hub] Gemini returned empty response text.');
    return;
  }

  console.log(`[AI Hub] Sending final AI response to ${phone}: ${finalReply}`);

  // 6. Send response via WhatsApp socket
  const jid = `${phone}@s.whatsapp.net`;
  await socket.sendMessage(jid, { text: finalReply });

  // Save the outgoing AI reply to database
  const msgId = 'AI_' + Date.now();
  await db.saveChatMessage(sessionId, msgId, phone, finalReply, true);

  // Emit to client UI
  if (io) {
    const userId = sessionId.split('_')[0];
    const userSessionId = sessionId.replace(`${userId}_`, '');
    io.to(`user_${userId}`).emit('new-message', {
      sessionId: userSessionId,
      msgId,
      phone,
      message: finalReply,
      fromMe: true,
      created_at: new Date()
    });
  }
}

module.exports = {
  handleIncomingMessage
};
