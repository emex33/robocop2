/**
 * Auth API Routes
 * Login, Register, Profile
 */

import { Router } from "express";
import { registerUser, loginUser, getUserProfile, updateUserProfile, authMiddleware } from "../db/auth.js";

const router = Router();

// Register
router.post("/register", (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: "Email, password, and name are required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const user = registerUser(email, password, name, company);
    res.status(201).json({ message: "Account created", user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
router.post("/login", (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const result = loginUser(email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Get profile (authenticated)
router.get("/profile", authMiddleware, (req, res) => {
  const user = getUserProfile(req.user.userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(user);
});

// Update profile (authenticated)
router.put("/profile", authMiddleware, (req, res) => {
  try {
    const user = updateUserProfile(req.user.userId, req.body);
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
