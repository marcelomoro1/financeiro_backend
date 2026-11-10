import { Router, Response } from "express";
import { register, login } from "../auth/authService";

const router = Router();

router.post("/register", async (req, res: Response) => {
  try {
    const { email, password, nome } = req.body;
    if (!email || !password || !nome) {
      res.status(400).json({ error: "Email, senha e nome são obrigatórios" });
      return;
    }
    const result = await register(email, password, nome);
    res.status(201).json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/login", async (req, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email e senha são obrigatórios" });
      return;
    }
    const result = await login(email, password);
    res.json(result);
  } catch (e: any) {
    res.status(401).json({ error: e.message });
  }
});

export default router;
