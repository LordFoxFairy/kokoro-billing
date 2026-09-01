import { z } from 'zod';

const actionSchema = z.object({ id: z.string().min(1), labelKey: z.string().min(1), kind: z.enum(['link', 'mutation', 'dangerMutation']), requiredPermission: z.string().min(1), route: z.string().min(1).optional(), method: z.enum(['POST', 'DELETE']).default('POST') }).strict();
const resourceSchema = z.object({ id: z.string().min(1), labelKey: z.string().min(1), route: z.string().min(1), requiredPermission: z.string().min(1), actions: z.array(actionSchema).default([]) }).strict();
const navSchema = z.object({ id: z.string().min(1), labelKey: z.string().min(1), route: z.string().min(1), requiredPermission: z.string().min(1) }).strict();
export const adminModuleManifestSchema = z.object({ id: z.string().min(1), labelKey: z.string().min(1), basePath: z.string().min(1), requiredPermission: z.string().min(1), navItems: z.array(navSchema).default([]), resources: z.array(resourceSchema).default([]) }).strict();
export type AdminModuleManifest = z.infer<typeof adminModuleManifestSchema>;
