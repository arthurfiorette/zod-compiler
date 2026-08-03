export const validTransformString = "  Hello World  ";

export const validTransformObject = {
  name: "Alice Developer",
  slug: "Hello World",
  score: 95.678,
};

export const validRefineString = "hello";

export const validRefineObject = {
  email: "alice@example.com",
  age: 28,
};

export const validCapturedTransformString = "alice";

export const validCapturedTransformObject = {
  label: "Alice",
  value: 42,
};

export const validCapturedRefineString = "user@example.com";

export const validCapturedRefineObject = {
  age: 28,
  confirm: "securepass123",
  email: "alice@example.com",
  id: "u_1",
  name: "Alice",
  password: "securepass123",
};

export const validSuperRefineObject = {
  age: 28,
  confirm: "securepass123",
  email: "alice@example.com",
  id: "u_1",
  name: "Alice",
  password: "securepass123",
};

export const validCoercedQuery = {
  page: "2",
  pageSize: "25",
  minPrice: "10.5",
  maxPrice: "250",
  includeArchived: "1",
  since: "2026-01-01T00:00:00Z",
};

export const invalidCoercedQuery = {
  ...validCoercedQuery,
  page: "not-a-number",
};

export const validStringBoolConfig = {
  analytics: "YES",
  cache: "no",
  compression: "enabled",
  debug: "0",
  experimental: "TRUE",
  gracefulShutdown: "off",
  metrics: "y",
  profiling: "disabled",
  rateLimit: "1",
  tracing: "FALSE",
  useTls: "on",
  verbose: "n",
};

export const invalidStringBoolConfig = {
  ...validStringBoolConfig,
  analytics: "maybe",
};

export class RequestToken {}

export const validCustomRequest = {
  active: true,
  age: 28,
  email: "alice@example.com",
  id: "u_1",
  score: 75,
  token: new RequestToken(),
};

export const invalidCustomRequest = {
  ...validCustomRequest,
  score: 20,
};
