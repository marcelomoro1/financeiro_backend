import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import prisma from "../../dados/armazenamento/prisma";
import { config } from "../config";

const JWT_EXPIRES = "7d";

export async function register(email: string, password: string, nome: string): Promise<{ token: string; user: { id: string; email: string; nome: string } }> {
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new Error("Email já cadastrado");

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, nome },
  });

  const token = jwt.sign({ userId: user.id }, config.jwtSecret, { expiresIn: JWT_EXPIRES });

  return { token, user: { id: user.id, email: user.email, nome: user.nome } };
}

export async function login(email: string, password: string): Promise<{ token: string; user: { id: string; email: string; nome: string } }> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("Credenciais inválidas");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new Error("Credenciais inválidas");

  const token = jwt.sign({ userId: user.id }, config.jwtSecret, { expiresIn: JWT_EXPIRES });

  return { token, user: { id: user.id, email: user.email, nome: user.nome } };
}

export function verifyToken(token: string): { userId: string } {
  return jwt.verify(token, config.jwtSecret) as { userId: string };
}
