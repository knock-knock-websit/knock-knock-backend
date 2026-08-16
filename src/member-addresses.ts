import { authenticatedMember } from "./member-auth";
import type { Env } from "./types";

type HandlerResult = { body: unknown; status?: number };
type AddressRow = {
  id: string;
  recipient: string;
  phone: string;
  storeProvider: string;
  storeId: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  isDefault: number;
};

const phonePattern = /^09\d{8}$/;

function ok(data: unknown, message: string, status = 200): HandlerResult {
  return { body: { success: true, message, data }, status };
}

function fail(message: string, status: number): HandlerResult {
  return { body: { success: false, message, data: null }, status };
}

async function bodyObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function addressInput(body: Record<string, unknown> | null) {
  if (!body) return null;
  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const pickupStore = body.pickupStore && typeof body.pickupStore === "object" && !Array.isArray(body.pickupStore)
    ? body.pickupStore as Record<string, unknown>
    : null;
  const provider = pickupStore?.provider === "UNIMART" ? "UNIMART" : "";
  const storeId = typeof pickupStore?.storeId === "string" ? pickupStore.storeId.trim() : "";
  if (!recipient || recipient.length > 80 || !phonePattern.test(phone) || !provider || !storeId || storeId.length > 30) return null;
  return { recipient, phone, provider, storeId, isDefault: body.isDefault === true };
}

function serializeAddress(row: AddressRow) {
  return {
    id: row.id,
    recipient: row.recipient,
    phone: row.phone,
    pickupStore: {
      provider: row.storeProvider,
      storeId: row.storeId,
      storeName: row.storeName,
      storeAddress: row.storeAddress,
      storePhone: row.storePhone,
    },
    isDefault: Boolean(row.isDefault),
  };
}

async function activeStore(env: Env, provider: string, storeId: string) {
  return env.DB.prepare(`
    SELECT provider, store_id AS storeId, store_name AS storeName,
      store_address AS storeAddress, store_phone AS storePhone
    FROM logistics_stores
    WHERE provider = ? AND store_id = ? AND active = 1
  `).bind(provider, storeId).first<{
    provider: string;
    storeId: string;
    storeName: string;
    storeAddress: string;
    storePhone: string;
  }>();
}

export async function listMemberAddresses(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const result = await env.DB.prepare(`
    SELECT id, recipient, phone, store_provider AS storeProvider, store_id AS storeId,
      store_name AS storeName, store_address AS storeAddress, store_phone AS storePhone,
      is_default AS isDefault
    FROM member_addresses
    WHERE member_id = ? AND store_provider = 'UNIMART' AND store_id IS NOT NULL
    ORDER BY is_default DESC, created_at ASC
  `).bind(member.id).all<AddressRow>();
  return ok(result.results.map(serializeAddress), "超商門市載入成功");
}

export async function createMemberAddress(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const input = addressInput(await bodyObject(request));
  if (!input) return fail("請輸入正確的收件人、手機號碼並選擇 7-ELEVEN 門市", 400);
  const store = await activeStore(env, input.provider, input.storeId);
  if (!store) return fail("所選的 7-ELEVEN 門市不存在或已停止服務，請重新選擇", 400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM member_addresses WHERE member_id = ? AND store_id IS NOT NULL")
    .bind(member.id).first<{ total: number }>();
  if ((count?.total ?? 0) >= 20) return fail("每位會員最多儲存 20 筆超商門市", 409);
  const id = crypto.randomUUID();
  const isDefault = input.isDefault || (count?.total ?? 0) === 0;
  const statements: D1PreparedStatement[] = [];
  if (isDefault) {
    statements.push(env.DB.prepare(
      "UPDATE member_addresses SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE member_id = ?",
    ).bind(member.id));
  }
  statements.push(env.DB.prepare(`
    INSERT INTO member_addresses
      (id, member_id, recipient, phone, city, address, store_provider, store_id,
       store_name, store_address, store_phone, is_default)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, member.id, input.recipient, input.phone, "超商取貨", store.storeAddress,
    store.provider, store.storeId, store.storeName, store.storeAddress, store.storePhone,
    isDefault ? 1 : 0,
  ));
  await env.DB.batch(statements);
  return ok(serializeAddress({
    id, recipient: input.recipient, phone: input.phone,
    storeProvider: store.provider, storeId: store.storeId, storeName: store.storeName,
    storeAddress: store.storeAddress, storePhone: store.storePhone,
    isDefault: isDefault ? 1 : 0,
  }), "超商門市已新增", 201);
}

export async function updateMemberAddress(
  request: Request,
  env: Env,
  id: string,
): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const body = await bodyObject(request);
  const input = addressInput(body);
  if (!input) return fail("請輸入正確的收件人、手機號碼並選擇 7-ELEVEN 門市", 400);
  const store = await activeStore(env, input.provider, input.storeId);
  if (!store) return fail("所選的 7-ELEVEN 門市不存在或已停止服務，請重新選擇", 400);
  const existing = await env.DB.prepare(`
    SELECT id, is_default AS isDefault FROM member_addresses WHERE id = ? AND member_id = ?
  `).bind(id, member.id).first<Pick<AddressRow, "id" | "isDefault">>();
  if (!existing) return fail("找不到超商門市", 404);
  const isDefault = input.isDefault || Boolean(existing.isDefault);
  const statements: D1PreparedStatement[] = [];
  if (input.isDefault) {
    statements.push(env.DB.prepare(`
      UPDATE member_addresses SET is_default = 0, updated_at = CURRENT_TIMESTAMP
      WHERE member_id = ? AND id <> ?
    `).bind(member.id, id));
  }
  statements.push(env.DB.prepare(`
    UPDATE member_addresses
    SET recipient = ?, phone = ?, city = ?, address = ?, store_provider = ?, store_id = ?,
      store_name = ?, store_address = ?, store_phone = ?, is_default = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND member_id = ?
  `).bind(
    input.recipient, input.phone, "超商取貨", store.storeAddress, store.provider, store.storeId,
    store.storeName, store.storeAddress, store.storePhone, isDefault ? 1 : 0, id, member.id,
  ));
  await env.DB.batch(statements);
  return ok(serializeAddress({
    id, recipient: input.recipient, phone: input.phone,
    storeProvider: store.provider, storeId: store.storeId, storeName: store.storeName,
    storeAddress: store.storeAddress, storePhone: store.storePhone,
    isDefault: isDefault ? 1 : 0,
  }), "超商門市已更新");
}

export async function deleteMemberAddress(
  request: Request,
  env: Env,
  id: string,
): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const existing = await env.DB.prepare(`
    SELECT id, is_default AS isDefault FROM member_addresses WHERE id = ? AND member_id = ?
  `).bind(id, member.id).first<Pick<AddressRow, "id" | "isDefault">>();
  if (!existing) return fail("找不到超商門市", 404);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM member_addresses WHERE id = ? AND member_id = ?").bind(id, member.id),
  ];
  if (existing.isDefault) {
    statements.push(env.DB.prepare(`
      UPDATE member_addresses SET is_default = 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM member_addresses
        WHERE member_id = ? AND id <> ? AND store_id IS NOT NULL
        ORDER BY created_at ASC LIMIT 1
      )
    `).bind(member.id, id));
  }
  await env.DB.batch(statements);
  return ok(null, "超商門市已刪除");
}
