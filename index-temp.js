require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    ttl: 14 * 24 * 60 * 60 // 14 days
  }),
  cookie: {
    maxAge: 14 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production"
  }
}));

// 🔹 MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// 🔹 Chat Schema & Model
const chatSchema = new mongoose.Schema({
  userMessage: String,
  botResponse: String,
  shloka: String,
  chapter: String,
  verse: String,
  createdAt: { type: Date, default: Date.now },
  isFavorite: { type: Boolean, default: false } // Add favorite flag
});

const Chat = mongoose.model("Chat", chatSchema);

// 🔹 Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// 🔹 Handle User Queries
app.post("/api/message", async (req, res) => {
  try {
    const { message, chatHistory } = req.body;
    if (!message) return res.status(400).json({ error: "Message is required" });

    // Use provided chat history if available, otherwise fetch from DB
    let history;
    if (chatHistory && chatHistory.length > 0) {
      history = chatHistory
        .map((chat) => `User: ${chat.userMessage}\nBot: ${chat.botResponse}`)
        .join("\n");
    } else {
      // Fetch recent chat history (last 5 messages for context)
      const recentChats = await Chat.find().sort({ createdAt: -1 }).limit(5);
      history = recentChats
        .map((chat) => `User: ${chat.userMessage}\nBot: ${chat.botResponse}`)
        .join("\n");
    }

    // Construct the AI prompt
    const prompt = `
    You are an expert in the Bhagavad Gita. Keep the conversation coherent by considering past messages.
    
    Here is the recent chat history:
    ${history}

    Now, answer the following in simple English with a relevant Sanskrit shloka in Sanskrit script.
    Also include which chapter and verse the shloka is from (e.g., Chapter 2, Verse 47).

    The format should be:
    Answer: <Your answer>
    Shloka: <Relevant Sanskrit shloka>
    Chapter: <chapter number>
    Verse: <verse number>

    Question: ${message}
    `;

    // 🔹 Get AI Response
    const result = await model.generateContent(prompt);
    const response = await result.response.text();
    console.log("Raw AI Response:", response);

    // 🔹 Extract Answer, Shloka, Chapter & Verse Properly
    const answerMatch = response.match(/Answer:\s*(.*?)\s*Shloka:/s);
    const shlokaMatch = response.match(/Shloka:\s*(.*?)(?:\s*Chapter:|$)/s);
    const chapterMatch = response.match(/Chapter:\s*(\d+)/);
    const verseMatch = response.match(/Verse:\s*(\d+)/);

    const answer = answerMatch ? answerMatch[1].trim() : "Answer not found";
    const shlokaWithMeaning = shlokaMatch ? shlokaMatch[1].trim() : "Shloka not found";
    const chapter = chapterMatch ? chapterMatch[1].trim() : "";
    const verse = verseMatch ? verseMatch[1].trim() : "";

    // 🔹 Save chat to database
    const chat = new Chat({ 
      userMessage: message, 
      botResponse: answer, 
      shloka: shlokaWithMeaning,
      chapter,
      verse,
      isFavorite: false // Initialize as not favorite
    });
    await chat.save();

    // 🔹 Send response
    res.json({ 
      botResponse: answer, 
      shloka: shlokaWithMeaning, 
      chapter, 
      verse,
      _id: chat._id,
      isFavorite: false 
    });

  } catch (error) {
    console.error("Error processing message:", error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// 🔹 Get Recent Chats
app.get("/api/chats", async (req, res) => {
  try {
    const chats = await Chat.find().sort({ createdAt: -1 }).limit(50);
    res.json(chats);
  } catch (error) {
    console.error("Error fetching chats:", error);
    res.status(500).json({ error: "Failed to fetch chats" });
  }
});

// BACKEND: Enhanced delete endpoint with improved error handling
app.delete("/api/chats/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if the ID is valid
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid chat ID format" });
    }
    
    // Find and delete the chat by ID
    const deletedChat = await Chat.findByIdAndDelete(id);
    
    if (!deletedChat) {
      return res.status(404).json({ error: "Chat not found with this ID" });
    }
    
    // Return success response with the deleted chat info
    return res.json({ 
      success: true, 
      message: "Chat deleted successfully",
      deletedChat: {
        _id: deletedChat._id,
        userMessage: deletedChat.userMessage,
        createdAt: deletedChat.createdAt
      }
    });
  } catch (error) {
    console.error("Error deleting chat by ID:", error);
    return res.status(500).json({ error: "Failed to delete chat" });
  }
});

// Keep the original index-based delete method as a fallback
app.delete("/api/chats/index/:index", async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    
    if (isNaN(index) || index < 0) {
      return res.status(400).json({ error: "Invalid chat index" });
    }
    
    // Get all chats in order without a limit to ensure we have all chats
    const chats = await Chat.find().sort({ createdAt: -1 });
    
    // Check if index is valid
    if (index >= chats.length) {
      return res.status(404).json({ error: "Chat index out of range" });
    }
    
    // Get the chat at the specified index
    const chatToDelete = chats[index];
    
    // Delete the chat by its ID
    const result = await Chat.findByIdAndDelete(chatToDelete._id);
    
    if (!result) {
      return res.status(404).json({ error: "Chat not found" });
    }
    
    // Return success response with the deleted chat info
    return res.json({ 
      success: true, 
      message: "Chat deleted successfully",
      deletedChat: {
        _id: chatToDelete._id,
        userMessage: chatToDelete.userMessage,
        createdAt: chatToDelete.createdAt
      }
    });
  } catch (error) {
    console.error("Error deleting chat by index:", error);
    return res.status(500).json({ error: "Failed to delete chat by index" });
  }
});
// 🔹 Toggle Favorite Status
app.put("/api/chats/:id/favorite", async (req, res) => {
  try {
    const { id } = req.params;
    const { isFavorite } = req.body;
    
    const updatedChat = await Chat.findByIdAndUpdate(
      id,
      { isFavorite: isFavorite },
      { new: true }
    );
    
    if (!updatedChat) {
      return res.status(404).json({ error: "Chat not found" });
    }
    
    res.json(updatedChat);
  } catch (error) {
    console.error("Error updating favorite status:", error);
    res.status(500).json({ error: "Failed to update favorite status" });
  }
});

// 🔹 Get Favorite Chats
app.get("/api/favorites", async (req, res) => {
  try {
    const favorites = await Chat.find({ isFavorite: true }).sort({ createdAt: -1 });
    res.json(favorites);
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).json({ error: "Failed to fetch favorites" });
  }
});

// 🔹 Share Chat (New Endpoint)
app.get("/api/share/:chatId", async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await Chat.findById(chatId);

    if (!chat) {
      return res.status(404).json({ error: "Chat not found" });
    }

    let shlokaInfo = chat.shloka;
    if (chat.chapter && chat.verse) {
      shlokaInfo += `\n(Bhagavad Gita ${chat.chapter}:${chat.verse})`;
    }

    const shareText = `🕉️ Bhagavad Gita Wisdom 🕉️\n\n✨ ${chat.botResponse}\n\n📖 Shloka: ${shlokaInfo}\n\n🔗 via Bhagavad Gita Bot`;

    res.json({ shareText });
  } catch (error) {
    console.error("Error sharing chat:", error);
    res.status(500).json({ error: "Failed to generate shareable text" });
  }
});

// 🔹 Test Route
app.get("/test", (req, res) => {
  res.send("Server is running!");
});

// 🔹 Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));