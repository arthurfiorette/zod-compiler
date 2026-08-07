import { NextResponse } from "next/server";
import { CreateUserSchema, ProductSchema } from "@/lib/schemas";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") ?? "user";
  const body: unknown = await request.json();

  const schema = type === "product" ? ProductSchema : CreateUserSchema;
  const result = schema.safeParse(body);

  // `.is()` only exists on a compiled schema, so this reports whether the
  // SHIPPED bundle really got the transform. Every other assertion in the e2e
  // passes on plain Zod too, which would let "the build silently stopped
  // compiling" go unnoticed — and unlike the build log, this survives a warm
  // transform cache.
  const compiled = typeof (schema as unknown as { is?: unknown }).is === "function";

  if (!result.success) {
    return NextResponse.json(
      { success: false, compiled, errors: result.error.issues },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, compiled, data: result.data });
}
