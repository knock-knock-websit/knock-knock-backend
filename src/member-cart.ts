import { authenticatedMember } from "./member-auth";
import type { Env } from "./types";

type HandlerResult = { body: unknown; status?: number };
type SpecificationValue = {
  specificationId: string;
  specificationName: string;
  optionId: string;
  optionName: string;
};
type VariantSnapshot = {
  productId: string;
  variantId: string;
  productName: string;
  productCategory: string;
  unitPrice: number;
  availableStock: number;
  specificationImageUrl: string | null;
  specificationsJson: string;
};
type CartRow = {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  productCategory: string;
  unitPrice: number;
  quantity: number;
  specificationsJson: string;
  totalPrice: number;
  specificationImageUrl: string | null;
  availableStock: number;
  createdAt: string;
  updatedAt: string;
};

const ok = (data: unknown, message = "操作成功", status = 200): HandlerResult => ({
  body: { success: true, message, data }, status,
});
const fail = (message: string, status: number, code?: string): HandlerResult => ({
  body: { success: false, message, ...(code ? { code } : {}), data: null }, status,
});

function serialize(row: CartRow) {
  let specifications: SpecificationValue[] = [];
  try { specifications = JSON.parse(row.specificationsJson) as SpecificationValue[]; } catch { /* empty */ }
  const { specificationsJson: _specificationsJson, ...item } = row;
  return { ...item, specifications };
}

async function requireMember(request: Request, env: Env) {
  return authenticatedMember(request, env);
}

async function variantSnapshot(env: Env, productId: string, variantId?: string): Promise<VariantSnapshot | null> {
  const variantCondition = variantId ? "AND variant.id = ?" : "";
  const statement = env.DB.prepare(`
    SELECT product.id AS productId, variant.id AS variantId,
      product.name AS productName, product.category AS productCategory,
      variant.price AS unitPrice, MAX(variant.stock - variant.reserved, 0) AS availableStock,
      COALESCE(
        variant.image_url,
        (SELECT color_image.image_url FROM product_color_images color_image
          INNER JOIN product_variant_option_values selected ON selected.option_id = color_image.option_id
          WHERE color_image.product_id = product.id AND selected.variant_id = variant.id LIMIT 1),
        (SELECT image.image_url FROM product_images image WHERE image.product_id = product.id AND image.active = 1
          ORDER BY image.is_primary DESC, image.sort_order ASC LIMIT 1),
        product.image_url
      ) AS specificationImageUrl,
      COALESCE((
        SELECT json_group_array(json_object(
          'specificationId', value.specification_id,
          'specificationName', specification.name,
          'optionId', value.option_id,
          'optionName', option.name
        ))
        FROM product_variant_option_values value
        INNER JOIN product_specifications specification ON specification.id = value.specification_id
        INNER JOIN product_specification_options option ON option.id = value.option_id
        WHERE value.variant_id = variant.id
        ORDER BY value.sort_order ASC
      ), '[]') AS specificationsJson
    FROM products product
    INNER JOIN product_variants variant ON variant.product_id = product.id
    WHERE product.id = ? AND product.active = 1 AND variant.purchasable = 1 ${variantCondition}
    ORDER BY variant.sort_order ASC, variant.created_at ASC
    LIMIT 1
  `);
  return (variantId ? statement.bind(productId, variantId) : statement.bind(productId)).first<VariantSnapshot>();
}

async function cartData(env: Env, memberId: string) {
  const result = await env.DB.prepare(`
    SELECT cart.id, cart.product_id AS productId, cart.variant_id AS variantId,
      cart.product_name AS productName, cart.product_category AS productCategory,
      cart.unit_price AS unitPrice, cart.quantity, cart.specifications_json AS specificationsJson,
      cart.total_price AS totalPrice, cart.specification_image_url AS specificationImageUrl,
      MAX(COALESCE(variant.stock - variant.reserved, 0), 0) AS availableStock,
      cart.created_at AS createdAt, cart.updated_at AS updatedAt
    FROM member_cart_items cart
    LEFT JOIN product_variants variant ON variant.id = cart.variant_id
    WHERE cart.member_id = ?
    ORDER BY cart.updated_at DESC, cart.created_at DESC
  `).bind(memberId).all<CartRow>();
  const items = result.results.map(serialize);
  return {
    items,
    totalQuantity: result.results.reduce((sum, item) => sum + item.quantity, 0),
    totalAmount: result.results.reduce((sum, item) => sum + item.totalPrice, 0),
  };
}

export async function listMemberCart(request: Request, env: Env): Promise<HandlerResult> {
  const member = await requireMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  return ok(await cartData(env, member.id), "購物車載入成功");
}

export async function addMemberCartItem(request: Request, env: Env): Promise<HandlerResult> {
  const member = await requireMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  let body: { productId?: unknown; variantId?: unknown; quantity?: unknown };
  try { body = await request.json(); } catch { return fail("購物車資料格式不正確", 400); }
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  const variantId = typeof body.variantId === "string" && body.variantId.trim() ? body.variantId.trim() : undefined;
  const quantity = Number(body.quantity ?? 1);
  if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) return fail("商品或數量格式不正確", 400);
  const snapshot = await variantSnapshot(env, productId, variantId);
  if (!snapshot) return fail("找不到可加入購物車的商品規格", 404);
  const existing = await env.DB.prepare(`
    SELECT id, quantity FROM member_cart_items
    WHERE member_id = ? AND product_id = ? AND variant_id = ?
  `).bind(member.id, productId, snapshot.variantId).first<{ id: string; quantity: number }>();
  const nextQuantity = (existing?.quantity ?? 0) + quantity;
  if (nextQuantity > 10) return fail("單一商品規格最多加入 10 件", 409);
  if (nextQuantity > snapshot.availableStock) return fail("商品庫存不足", 409, "OUT_OF_STOCK");
  if (existing) {
    await env.DB.prepare(`
      UPDATE member_cart_items SET product_name = ?, product_category = ?, unit_price = ?,
        quantity = ?, specifications_json = ?, total_price = ?, specification_image_url = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND member_id = ?
    `).bind(
      snapshot.productName, snapshot.productCategory, snapshot.unitPrice, nextQuantity,
      snapshot.specificationsJson, snapshot.unitPrice * nextQuantity, snapshot.specificationImageUrl,
      existing.id, member.id,
    ).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO member_cart_items (
        id, member_id, product_id, variant_id, product_name, product_category,
        unit_price, quantity, specifications_json, total_price, specification_image_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), member.id, productId, snapshot.variantId,
      snapshot.productName, snapshot.productCategory, snapshot.unitPrice, quantity,
      snapshot.specificationsJson, snapshot.unitPrice * quantity, snapshot.specificationImageUrl,
    ).run();
  }
  return ok(await cartData(env, member.id), "商品已加入購物車", existing ? 200 : 201);
}

export async function updateMemberCartItem(request: Request, env: Env, id: string): Promise<HandlerResult> {
  const member = await requireMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  let body: { quantity?: unknown; variantId?: unknown };
  try { body = await request.json(); } catch { return fail("購物車資料格式不正確", 400); }
  const current = await env.DB.prepare(`
    SELECT product_id AS productId, variant_id AS variantId, quantity
    FROM member_cart_items WHERE id = ? AND member_id = ?
  `).bind(id, member.id).first<{ productId: string; variantId: string; quantity: number }>();
  if (!current) return fail("找不到購物車商品", 404);
  const quantity = body.quantity === undefined ? current.quantity : Number(body.quantity);
  const variantId = typeof body.variantId === "string" && body.variantId.trim() ? body.variantId.trim() : current.variantId;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return fail("商品數量需為 1 至 10", 400);
  const snapshot = await variantSnapshot(env, current.productId, variantId);
  if (!snapshot) return fail("找不到可購買的商品規格", 404);
  if (quantity > snapshot.availableStock) return fail("商品庫存不足", 409, "OUT_OF_STOCK");
  if (variantId !== current.variantId) {
    const duplicate = await env.DB.prepare(`
      SELECT id FROM member_cart_items WHERE member_id = ? AND product_id = ? AND variant_id = ? AND id <> ?
    `).bind(member.id, current.productId, variantId, id).first();
    if (duplicate) return fail("此商品規格已在購物車中", 409, "CART_ITEM_EXISTS");
  }
  await env.DB.prepare(`
    UPDATE member_cart_items SET variant_id = ?, product_name = ?, product_category = ?,
      unit_price = ?, quantity = ?, specifications_json = ?, total_price = ?,
      specification_image_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND member_id = ?
  `).bind(
    snapshot.variantId, snapshot.productName, snapshot.productCategory, snapshot.unitPrice,
    quantity, snapshot.specificationsJson, snapshot.unitPrice * quantity,
    snapshot.specificationImageUrl, id, member.id,
  ).run();
  return ok(await cartData(env, member.id), "購物車商品已更新");
}

export async function deleteMemberCartItem(request: Request, env: Env, id: string): Promise<HandlerResult> {
  const member = await requireMember(request, env);
  if (!member) return fail("請先登入會員", 401, "AUTH_REQUIRED");
  const result = await env.DB.prepare("DELETE FROM member_cart_items WHERE id = ? AND member_id = ?")
    .bind(id, member.id).run();
  if (!result.meta.changes) return fail("找不到購物車商品", 404);
  return ok(await cartData(env, member.id), "購物車商品已刪除");
}
