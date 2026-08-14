const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const db = require('./db');

/**
 * Handle incoming WhatsApp messages through Gemini API & MCP Tool routing
 */
async function handleIncomingMessage(sessionId, phone, incomingText, socket, io, replyJid = null) {
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

    // Role-Based Access Control (Whitelist Admin)
    if (mcp.allowed_numbers && mcp.allowed_numbers.trim() !== '') {
      const allowedArray = mcp.allowed_numbers.split(',').map(n => {
        let clean = n.trim().replace(/[^0-9]/g, '');
        // Standardize Indonesian numbers: replace leading 0 with 62
        if (clean.startsWith('0')) {
          clean = '62' + clean.substring(1);
        }
        return clean;
      });
      
      let sanitizedPhone = phone.replace(/[^0-9]/g, '');
      if (sanitizedPhone.startsWith('0')) {
        sanitizedPhone = '62' + sanitizedPhone.substring(1);
      }
      
      if (!allowedArray.includes(sanitizedPhone)) {
        console.log(`[AI Hub] Access DENIED for phone ${phone} (sanitized: ${sanitizedPhone}) to project ${mcp.project_name}. Allowed: ${allowedArray.join(', ')}`);
        // Kita juga tambahkan konteks ke prompt agar AI tahu bahwa proyek ini diblokir untuk user tersebut
        systemInstruction += `\n\n[INFO SISTEM] Akses ke proyek ${mcp.project_name} DITOLAK untuk nomor ${phone}. Anda tidak memiliki alat untuk proyek ini. Jawab dengan sopan bahwa fitur tersebut khusus Admin.`;
        continue; // Skip loading tools from this MCP
      } else {
        console.log(`[AI Hub] Access GRANTED for phone ${phone} to project ${mcp.project_name}.`);
      }
    }
    
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
    model: 'gemini-2.5-flash',
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
  
  // Format history and enforce strictly alternating roles (user -> model -> user)
  const rawContents = chatHistory.slice(-10).map(msg => ({
    role: msg.from_me === 1 ? 'model' : 'user',
    text: msg.message
  }));
  rawContents.push({ role: 'user', text: incomingText });

  const contents = [];
  for (const item of rawContents) {
    if (contents.length > 0 && contents[contents.length - 1].role === item.role) {
      // Squash consecutive messages from the same role
      contents[contents.length - 1].parts[0].text += `\n${item.text}`;
    } else {
      contents.push({
        role: item.role,
        parts: [{ text: item.text }]
      });
    }
  }

  // Ensure the very first message is 'user' (Gemini requirement for starting history)
  if (contents.length > 0 && contents[0].role === 'model') {
    contents.shift(); // Remove the first model message if it exists without a prior user message
  }

  let result;
  let response;
  try {
    const currentJid = replyJid || `${phone}@s.whatsapp.net`;
    // Munculkan efek "Mengetik..." (typing) di WA pengguna agar natural
    try {
      await socket.sendPresenceUpdate('composing', currentJid);
    } catch (e) {}

    console.log(`[AI Hub] Invoking Gemini model for ${phone}...`);
    result = await model.generateContent({
      contents
    });
    response = result.response;

    // 5. Handle Function Calls (The Spoke Bridge)
    let functionCalls = typeof response.functionCalls === 'function' ? response.functionCalls() : response.functionCalls;
    while (functionCalls && functionCalls.length > 0) {
      // Teks sementara (intermediate text) yang dihasilkan Gemini saat memanggil alat 
      // tidak lagi kita kirim ke WhatsApp agar balasan langsung "to the point" (tidak spam).
      
      // Refresh efek "Mengetik..." agar tidak hilang jika fungsi berjalan lama
      try {
        await socket.sendPresenceUpdate('composing', currentJid);
      } catch (e) {}

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
            // Refresh efek "Mengetik..." setelah memanggil alat, saat AI mensintesis jawaban final
        try {
          await socket.sendPresenceUpdate('composing', currentJid);
        } catch (e) {}

        // Feed the function execution result back to the model
        result = await model.generateContent({
          contents: [
          ...contents,
          {
            role: 'model',
            parts: response.candidates[0].content.parts
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
      functionCalls = typeof response.functionCalls === 'function' ? response.functionCalls() : response.functionCalls;
    }
  } catch (err) {
    console.error(`[AI Hub] Fatal error from Gemini API:`, err.message);
    const errorMsg = `[Sistem HANDCAP] Maaf, otak AI gagal merespons. Kendala: ${err.message}`;
    const fallbackJid = replyJid || `${phone}@s.whatsapp.net`;
    await socket.sendMessage(fallbackJid, { text: errorMsg });
    return;
  }

  let finalReply = '';
  try {
    finalReply = typeof response.text === 'function' ? response.text() : '';
  } catch (err) {
    console.warn('[AI Hub] No text found in Gemini response (perhaps only function calls).');
  }

  if (!finalReply) {
    console.warn('[AI Hub] Gemini returned empty response text. Sending fallback reply.');
    finalReply = 'Maaf, saya tidak bisa memproses permintaan Anda saat ini. Silakan coba lagi.';
  }

  console.log(`[AI Hub] Sending final AI response to ${phone}: ${finalReply}`);

  // Hentikan efek "Mengetik..." sebelum mengirim pesan final (opsional, tapi baik untuk clean-up)
  try {
    const finalJid = replyJid || `${phone}@s.whatsapp.net`;
    await socket.sendPresenceUpdate('paused', finalJid);
  } catch (e) {}

  // 6. Send response via WhatsApp socket
  // Use the original JID from the incoming message (avoids LID JID issues like 169999xxx)
  const finalDestJid = replyJid || `${phone}@s.whatsapp.net`;
  console.log(`[AI Hub] Sending reply to JID: ${finalDestJid}`);
  await socket.sendMessage(finalDestJid, { text: finalReply });

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
