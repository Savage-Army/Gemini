const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const port = 3000;
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

// Directory to store chat histories
const historyDir = path.join(__dirname, 'history');

app.use(express.json());

// Function to convert image URLs to Gemini API Part objects
function getImageParts(imageUrls) {
  return Object.values(imageUrls).map((imageUrl, index) => {
    return {
      inlineData: {
        data: Buffer.from(imageUrl).toString('base64'),
        mimeType: 'image/png', // Adjust mime type based on the image format
      },
      index: index + 1, // Index starts from 1
    };
  });
}

// Function to parse the Gemini API result
async function parseResult(result) {
  let text = '';
  for await (const chunk of result.stream) {
    text += chunk.text();
  }
  return text;
}

// Function to load chat history from a file with timestamp
async function loadChatHistoryWithTimestamp(historyPath) {
  try {
    const data = await fs.readFile(historyPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    // If the file doesn't exist, return an empty array
    return { history: [], timestamp: null };
  }
}

// Function to save chat history to a file with timestamp
async function saveChatHistoryWithTimestamp(historyPath, chatHistory) {
  const data = JSON.stringify({ history: chatHistory, timestamp: Date.now() }, null, 2);
  await fs.writeFile(historyPath, data, 'utf-8');
}

// Function to delete old chat history files
async function deleteOldChatHistoryFiles() {
  const files = await fs.readdir(historyDir);
  files.forEach(async (file) => {
    const filePath = path.join(historyDir, file);
    const stats = await fs.stat(filePath);
    // Check if the file is older than 1 hour
    if (Date.now() - stats.birthtimeMs > 60 * 60 * 1000) {
      // Delete the file
      await fs.unlink(filePath);
      console.log(`Deleted old chat history file: ${file}`);
    }
  });
}

// Schedule the deletion of old chat history files every hour
setInterval(deleteOldChatHistoryFiles, 60 * 60 * 1000);

// Function to clear chat history for a given chat ID
async function clearChatHistory(chatid) {
  const historyPath = path.join(historyDir, `${chatid}.json`);
  try {
    await fs.unlink(historyPath);
    console.log(`Deleted chat history file: ${chatid}.json`);
    return 'History cleared';
  } catch (error) {
    console.error(`Error deleting chat history: ${error}`);
    return 'Error clearing history';
  }
}

app.get('/gemini', async (req, res) => {
  try {
    const { query, chatid, ...imageUrls } = req.query;

    // Check if chatid is provided
    if (!chatid) {
      return res.status(400).json({ error: 'Chat ID (passcode) is required.' });
    }

    // Check for clear history queries
    if (query.toLowerCase().match(/^(clear|clear history|clear chat)$/)) {
      const response = await clearChatHistory(chatid);
      return res.json({ response, chatid });
    }

    // Create directory if it doesn't exist
    await fs.mkdir(historyDir, { recursive: true });

    // Path to the chat history JSON file
    const historyPath = path.join(historyDir, `${chatid}.json`);

    // Initialize or load chat history with timestamp
    const { history: chatHistory, timestamp } = await loadChatHistoryWithTimestamp(historyPath);

    // Check if the chat history is older than 1 hour
    if (timestamp && Date.now() - timestamp > 60 * 60 * 1000) {
      // If older than 1 hour, delete the file and create a new one
      await fs.unlink(historyPath);
      console.log(`Deleted old chat history file: ${chatid}.json`);
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-pro',
      generationConfig: {
        maxOutputTokens: 1000, // Adjust based on your model and requirements
        temperature: 0.7, // Experiment with temperature for diversity
        topP: 0.9, // Experiment with top-p for controlling randomness
      },
    });

    // Process text and image input in a single call
    const imageParts = getImageParts(imageUrls);

    // Flatten the chat history array for use in countTokens and generateContentStream
    const flattenedChatHistory = chatHistory.flatMap(pair => pair);
    const totalTokens = await model.countTokens([...flattenedChatHistory, query, ...imageParts]);
    console.log('Total tokens:', totalTokens);

    const result = await model.generateContentStream([...flattenedChatHistory, query, ...imageParts]);
    const response = await parseResult(result);

    // Update chat history
    chatHistory.push([query, response]); // Store each query-response pair as an array

    // Save chat history with timestamp
    await saveChatHistoryWithTimestamp(historyPath, chatHistory);

    // Respond with the model's generated text
    res.json({ response, chatid, totalTokens });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
