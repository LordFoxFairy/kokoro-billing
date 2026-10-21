import { BadRequestException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
export function assertOpenCreditAccountInput(request: FastifyRequest): void {
  const mime = request.headers["content-type"];
  const body: unknown = request.body;
  if (
    request.url.includes("?") ||
    typeof mime !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(mime) ||
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (Object.getPrototypeOf(body) !== Object.prototype &&
      Object.getPrototypeOf(body) !== null) ||
    Reflect.ownKeys(body).length !== 0
  )
    throw new BadRequestException();
}
