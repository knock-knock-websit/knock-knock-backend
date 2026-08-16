import type { Env, OrderItemInput } from "./types";
import { authenticatedMember } from "./member-auth";
import { findSevenElevenStore } from "./logistics";

export type HandlerResult = { body: unknown; status?: number };

type PromotionRow = {
  id: string;
  name: string;
  description: string;
  promotionMethod: "coupon" | "promo_code" | "automatic";
  discountType: "fixed" | "percentage" | "free_shipping";
  discountValue: number;
  maxDiscount: number | null;
  minOrderAmount: number;
  scopeType: "all" | "products" | "categories";
  memberType: "all" | "new_member" | "vip" | "specific_users";
  startAt: string;
  endAt: string;
  totalUsageLimit: number | null;
  perUserLimit: number;
  claimLimit: number | null;
  couponValidDays: number | null;
  claimedCount: number;
  usedCount: number;
  status: "draft" | "active" | "disabled" | "expired";
  revision: number;
};

type CodeRow = { id: string; code: string; usageLimit: number | null; usedCount: number; enabled: number };
type MemberContext = { id: string; email: string; memberLevel: string; createdAt: string };
type CartProduct = { id: string; variantId: string; name: string; price: number; inventory: number; categoryId: string | null; imageUrl: string | null; specificationsJson: string };
type PricedItem = CartProduct & { quantity: number; lineTotal: number };
type ShippingMethod = "home" | "store" | "express";

const promotionColumns = `
  id, name, description, promotion_method AS promotionMethod,
  discount_type AS discountType, discount_value AS discountValue,
  max_discount AS maxDiscount, min_order_amount AS minOrderAmount,
  scope_type AS scopeType, member_type AS memberType,
  start_at AS startAt, end_at AS endAt,
  total_usage_limit AS totalUsageLimit, per_user_limit AS perUserLimit,
  claim_limit AS claimLimit, coupon_valid_days AS couponValidDays,
  claimed_count AS claimedCount, used_count AS usedCount, status, revision
`;

const messages: Record<string, string> = {
  COUPON_NOT_FOUND: "找不到此優惠碼",
  COUPON_EXPIRED: "此優惠已過期",
  COUPON_NOT_STARTED: "此優惠尚未開始",
  COUPON_DISABLED: "此優惠目前未啟用",
  COUPON_USAGE_LIMIT: "此優惠的使用次數已達上限",
  USER_USAGE_LIMIT: "你已達此優惠的使用次數上限",
  MIN_ORDER_NOT_REACHED: "訂單金額尚未達到優惠門檻",
  PRODUCT_NOT_ELIGIBLE: "購物車內沒有符合此優惠的商品",
  MEMBER_NOT_ELIGIBLE: "你不符合此優惠的會員資格",
  ALREADY_CLAIMED: "你已領取過此優惠券",
  CLAIM_LIMIT_REACHED: "此優惠券已領取完畢",
  INVALID_COUPON: "優惠券無效或已無法使用",
  PROMOTION_CHANGED: "優惠內容剛剛已更新，請重新確認訂單金額",
  LOGIN_REQUIRED: "請先登入會員",
  INVALID_CART: "購物車商品格式不正確",
  PRODUCT_NOT_FOUND: "部分商品已下架或不存在",
  OUT_OF_STOCK: "部分商品庫存不足",
  PICKUP_STORE_REQUIRED: "請先選擇 7-ELEVEN 取貨門市",
  PICKUP_STORE_INVALID: "所選的 7-ELEVEN 門市不存在或已停止服務，請重新選擇",
  BANK_TRANSFER_NOT_CONFIGURED: "銀行轉帳資訊尚未設定，請稍後再試",
};

class PromotionError extends Error {
  constructor(public code: string, public status = 400, message = messages[code] ?? "優惠無法使用") {
    super(message);
  }
}

function ok(data: unknown, message = "操作成功", status = 200): HandlerResult {
  return { body: { success: true, message, data }, status };
}

function fail(error: unknown, fallbackMessage = "優惠服務暫時無法使用"): HandlerResult {
  if (error instanceof PromotionError) {
    return { body: { success: false, code: error.code, message: error.message, data: null }, status: error.status };
  }
  const value = error instanceof Error ? error.message : String(error);
  const code = Object.keys(messages).find((candidate) => value.includes(candidate));
  if (code) return { body: { success: false, code, message: messages[code], data: null }, status: 409 };
  console.error("Promotion operation failed", error);
  return { body: { success: false, code: "PROMOTION_ERROR", message: fallbackMessage, data: null }, status: 500 };
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object") return body as Record<string, unknown>;
  } catch { /* handled below */ }
  throw new PromotionError("INVALID_CART");
}

function isItem(value: unknown): value is OrderItemInput {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.productId === "string" && item.productId.length > 0
    && (item.variantId === undefined || typeof item.variantId === "string")
    && Number.isInteger(item.quantity) && Number(item.quantity) > 0 && Number(item.quantity) <= 10;
}

async function memberContext(request: Request, env: Env, required = false): Promise<MemberContext | null> {
  const authenticated = await authenticatedMember(request, env);
  if (!authenticated) {
    if (required) throw new PromotionError("LOGIN_REQUIRED", 401);
    return null;
  }
  const member = await env.DB.prepare(`
    SELECT id, email, member_level AS memberLevel, created_at AS createdAt FROM members WHERE id = ?
  `).bind(authenticated.id).first<MemberContext>();
  if (!member && required) throw new PromotionError("LOGIN_REQUIRED", 401);
  return member;
}

async function priceCart(env: Env, rawItems: unknown): Promise<{ items: PricedItem[]; subtotal: number }> {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 20 || !rawItems.every(isItem)) {
    throw new PromotionError("INVALID_CART");
  }
  const quantities = new Map<string, OrderItemInput>();
  rawItems.forEach((item) => {
    const key = `${item.productId}:${item.variantId ?? ""}`;
    const existing = quantities.get(key);
    quantities.set(key, { ...item, quantity: (existing?.quantity ?? 0) + item.quantity });
  });
  if ([...quantities.values()].some((item) => item.quantity > 10)) throw new PromotionError("INVALID_CART");
  const requested = [...quantities.values()];
  const products = await Promise.all(requested.map(async (item) => {
    const variantCondition = item.variantId ? "AND variant.id = ?" : "";
    const statement = env.DB.prepare(`
      SELECT product.id, variant.id AS variantId, product.name, variant.price,
        MAX(variant.stock - variant.reserved, 0) AS inventory,
        product.category_id AS categoryId,
        COALESCE(variant.image_url, (
          SELECT image.image_url FROM product_images image
          WHERE image.product_id = product.id
          ORDER BY image.is_primary DESC, image.sort_order ASC LIMIT 1
        )) AS imageUrl,
        COALESCE((
          SELECT json_group_array(json_object(
            'specificationName', specification.name,
            'optionName', option.name
          ))
          FROM product_variant_option_values relation
          INNER JOIN product_specifications specification ON specification.id = relation.specification_id
          INNER JOIN product_specification_options option ON option.id = relation.option_id
          WHERE relation.variant_id = variant.id
          ORDER BY relation.sort_order ASC
        ), '[]') AS specificationsJson
      FROM products product
      INNER JOIN product_variants variant ON variant.product_id = product.id
      WHERE product.active = 1 AND variant.purchasable = 1 AND product.id = ? ${variantCondition}
      ORDER BY variant.sort_order ASC LIMIT 1
    `);
    return (item.variantId ? statement.bind(item.productId, item.variantId) : statement.bind(item.productId)).first<CartProduct>();
  }));
  if (products.some((product) => !product)) throw new PromotionError("PRODUCT_NOT_FOUND", 409);
  const items = products.map((product, index) => {
    const quantity = requested[index].quantity;
    if (!product) throw new PromotionError("PRODUCT_NOT_FOUND", 409);
    if (product.inventory < quantity) throw new PromotionError("OUT_OF_STOCK", 409, `${product.name} 庫存不足`);
    return { ...product, quantity, lineTotal: product.price * quantity };
  });
  return { items, subtotal: items.reduce((sum, item) => sum + item.lineTotal, 0) };
}

function shippingAmount(method: ShippingMethod, subtotal: number): number {
  if (method === "store") return 60;
  if (method === "express") return 150;
  return subtotal >= 1500 ? 0 : 80;
}

function validateLifecycle(promotion: PromotionRow) {
  if (promotion.status === "expired") throw new PromotionError("COUPON_EXPIRED");
  if (promotion.status !== "active") throw new PromotionError("COUPON_DISABLED");
  const now = Date.now();
  if (Date.parse(promotion.startAt) > now) throw new PromotionError("COUPON_NOT_STARTED");
  if (Date.parse(promotion.endAt) < now) throw new PromotionError("COUPON_EXPIRED");
  if (promotion.totalUsageLimit !== null && promotion.usedCount >= promotion.totalUsageLimit) {
    throw new PromotionError("COUPON_USAGE_LIMIT");
  }
}

async function validateMember(env: Env, promotion: PromotionRow, member: MemberContext | null) {
  if (promotion.memberType === "all") return;
  if (!member) throw new PromotionError("LOGIN_REQUIRED", 401);
  if (promotion.memberType === "vip" && member.memberLevel !== "vip") throw new PromotionError("MEMBER_NOT_ELIGIBLE");
  if (promotion.memberType === "new_member" && Date.parse(member.createdAt) < Date.now() - 30 * 86_400_000) {
    throw new PromotionError("MEMBER_NOT_ELIGIBLE");
  }
  if (promotion.memberType === "specific_users") {
    const eligible = await env.DB.prepare("SELECT 1 FROM promotion_users WHERE promotion_id = ? AND user_id = ?")
      .bind(promotion.id, member.id).first();
    if (!eligible) throw new PromotionError("MEMBER_NOT_ELIGIBLE");
  }
}

async function validateUserLimit(env: Env, promotion: PromotionRow, member: MemberContext | null) {
  if (!member) return;
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM coupon_usages WHERE promotion_id = ? AND user_id = ?
  `).bind(promotion.id, member.id).first<{ count: number }>();
  if (Number(result?.count ?? 0) >= promotion.perUserLimit) throw new PromotionError("USER_USAGE_LIMIT");
}

async function eligibleAmount(env: Env, promotion: PromotionRow, items: PricedItem[]): Promise<number> {
  if (promotion.scopeType === "all") return items.reduce((sum, item) => sum + item.lineTotal, 0);
  const rows = promotion.scopeType === "products"
    ? await env.DB.prepare(`SELECT product_id AS id FROM promotion_products WHERE promotion_id = ?`).bind(promotion.id).all<{ id: string }>()
    : await env.DB.prepare(`
        WITH RECURSIVE eligible_categories(id) AS (
          SELECT category_id FROM promotion_categories WHERE promotion_id = ?
          UNION ALL
          SELECT category.id FROM product_categories category
          INNER JOIN eligible_categories parent ON category.parent_id = parent.id
        )
        SELECT id FROM eligible_categories
      `).bind(promotion.id).all<{ id: string }>();
  const eligibleIds = new Set(rows.results.map((row) => row.id));
  return items.reduce((sum, item) => {
    const matches = promotion.scopeType === "products"
      ? eligibleIds.has(item.id)
      : Boolean(item.categoryId && eligibleIds.has(item.categoryId));
    return sum + (matches ? item.lineTotal : 0);
  }, 0);
}

async function calculate(
  env: Env,
  promotion: PromotionRow,
  items: PricedItem[],
  subtotal: number,
  shippingBeforeDiscount: number,
) {
  if (subtotal < promotion.minOrderAmount) throw new PromotionError("MIN_ORDER_NOT_REACHED");
  const eligible = await eligibleAmount(env, promotion, items);
  if (eligible <= 0) throw new PromotionError("PRODUCT_NOT_ELIGIBLE");
  let discount = 0;
  let shippingDiscount = 0;
  if (promotion.discountType === "fixed") discount = Math.min(promotion.discountValue, eligible);
  if (promotion.discountType === "percentage") {
    discount = Math.floor(eligible * promotion.discountValue / 100);
    if (promotion.maxDiscount !== null) discount = Math.min(discount, promotion.maxDiscount);
  }
  if (promotion.discountType === "free_shipping") shippingDiscount = shippingBeforeDiscount;
  return { eligibleAmount: eligible, discount, shippingDiscount };
}

async function getPromotion(env: Env, id: string): Promise<PromotionRow | null> {
  return env.DB.prepare(`SELECT ${promotionColumns} FROM promotions WHERE id = ?`).bind(id).first<PromotionRow>();
}

async function getPromoCode(env: Env, rawCode: unknown): Promise<{ promotion: PromotionRow; code: CodeRow }> {
  const codeValue = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : "";
  if (!codeValue) throw new PromotionError("COUPON_NOT_FOUND", 404);
  const row = await env.DB.prepare(`
    SELECT id, promotion_id AS promotionId, code, usage_limit AS usageLimit, used_count AS usedCount, enabled
    FROM coupon_codes WHERE code = ? COLLATE NOCASE
  `).bind(codeValue).first<CodeRow & { promotionId: string }>();
  if (!row) throw new PromotionError("COUPON_NOT_FOUND", 404);
  if (!row.enabled) throw new PromotionError("COUPON_DISABLED");
  if (row.usageLimit !== null && row.usedCount >= row.usageLimit) throw new PromotionError("COUPON_USAGE_LIMIT");
  const promotion = await getPromotion(env, row.promotionId);
  if (!promotion || promotion.promotionMethod !== "promo_code") throw new PromotionError("INVALID_COUPON");
  return { promotion, code: row };
}

type Applied = {
  promotion: PromotionRow;
  code: CodeRow | null;
  userCouponId: string | null;
  discount: number;
  shippingDiscount: number;
  eligibleAmount: number;
};

async function resolveApplied(
  env: Env,
  member: MemberContext | null,
  cart: { items: PricedItem[]; subtotal: number },
  shipping: number,
  couponCode: unknown,
  userCouponId: unknown,
): Promise<Applied | null> {
  if (couponCode && userCouponId) throw new PromotionError("INVALID_COUPON", 400, "優惠碼與優惠券只能擇一使用");
  let promotion: PromotionRow | null = null;
  let code: CodeRow | null = null;
  let selectedCouponId: string | null = null;
  if (couponCode) ({ promotion, code } = await getPromoCode(env, couponCode));
  if (userCouponId) {
    if (!member) throw new PromotionError("LOGIN_REQUIRED", 401);
    const coupon = await env.DB.prepare(`
      SELECT promotion_id AS promotionId, status, expires_at AS expiresAt
      FROM user_coupons WHERE id = ? AND user_id = ?
    `).bind(String(userCouponId), member.id).first<{ promotionId: string; status: string; expiresAt: string }>();
    if (!coupon || coupon.status !== "available") throw new PromotionError("INVALID_COUPON");
    if (Date.parse(coupon.expiresAt) < Date.now()) throw new PromotionError("COUPON_EXPIRED");
    promotion = await getPromotion(env, coupon.promotionId);
    selectedCouponId = String(userCouponId);
  }
  if (!promotion) {
    const automatic = await env.DB.prepare(`
      SELECT ${promotionColumns} FROM promotions
      WHERE promotion_method = 'automatic' AND status = 'active'
        AND datetime(start_at) <= CURRENT_TIMESTAMP AND datetime(end_at) >= CURRENT_TIMESTAMP
      ORDER BY discount_value DESC, created_at ASC
    `).all<PromotionRow>();
    let best: Applied | null = null;
    for (const candidate of automatic.results) {
      try {
        await validateMember(env, candidate, member);
        await validateUserLimit(env, candidate, member);
        const computed = await calculate(env, candidate, cart.items, cart.subtotal, shipping);
        const applied = { promotion: candidate, code: null, userCouponId: null, ...computed };
        if (!best || applied.discount + applied.shippingDiscount > best.discount + best.shippingDiscount) best = applied;
      } catch (error) {
        if (!(error instanceof PromotionError)) throw error;
      }
    }
    return best;
  }
  validateLifecycle(promotion);
  await validateMember(env, promotion, member);
  await validateUserLimit(env, promotion, member);
  return { promotion, code, userCouponId: selectedCouponId, ...await calculate(env, promotion, cart.items, cart.subtotal, shipping) };
}

function previewData(cart: { subtotal: number }, shipping: number, applied: Applied | null) {
  const discount = applied?.discount ?? 0;
  const shippingAfterDiscount = Math.max(0, shipping - (applied?.shippingDiscount ?? 0));
  return {
    subtotal: cart.subtotal,
    eligibleAmount: applied?.eligibleAmount ?? 0,
    discount,
    shipping: shippingAfterDiscount,
    shippingDiscount: applied?.shippingDiscount ?? 0,
    total: Math.max(0, cart.subtotal - discount + shippingAfterDiscount),
    promotion: applied ? { id: applied.promotion.id, name: applied.promotion.name } : null,
    couponCode: applied?.code?.code ?? null,
    userCouponId: applied?.userCouponId ?? null,
  };
}

export async function listCoupons(request: Request, env: Env): Promise<HandlerResult> {
  try {
    const member = await memberContext(request, env, true);
    const result = await env.DB.prepare(`
      SELECT ${promotionColumns}
      FROM promotions WHERE promotion_method = 'coupon' AND status = 'active'
        AND datetime(start_at) <= CURRENT_TIMESTAMP AND datetime(end_at) >= CURRENT_TIMESTAMP
      ORDER BY end_at ASC, created_at DESC
    `).all<PromotionRow>();
    const data = [];
    for (const promotion of result.results) {
      try { await validateMember(env, promotion, member); } catch { continue; }
      const claimed = member ? await env.DB.prepare(`
        SELECT COUNT(*) AS count FROM user_coupons WHERE user_id = ? AND promotion_id = ?
      `).bind(member.id, promotion.id).first<{ count: number }>() : null;
      data.push({
        id: promotion.id, name: promotion.name, description: promotion.description,
        discountType: promotion.discountType, discountValue: promotion.discountValue,
        maxDiscount: promotion.maxDiscount, minOrderAmount: promotion.minOrderAmount,
        scopeType: promotion.scopeType, startAt: promotion.startAt, expiresAt: promotion.endAt,
        remaining: promotion.claimLimit === null ? null : Math.max(0, promotion.claimLimit - promotion.claimedCount),
        claimed: Number(claimed?.count ?? 0) >= promotion.perUserLimit,
      });
    }
    return ok(data, "優惠券中心載入成功");
  } catch (error) { return fail(error); }
}

export async function claimCoupon(request: Request, env: Env, promotionId: string): Promise<HandlerResult> {
  try {
    const member = await memberContext(request, env, true);
    const promotion = await getPromotion(env, promotionId);
    if (!promotion || promotion.promotionMethod !== "coupon") throw new PromotionError("COUPON_NOT_FOUND", 404);
    validateLifecycle(promotion);
    await validateMember(env, promotion, member);
    if (promotion.claimLimit !== null && promotion.claimedCount >= promotion.claimLimit) throw new PromotionError("CLAIM_LIMIT_REACHED");
    const daysExpiry = promotion.couponValidDays
      ? new Date(Date.now() + promotion.couponValidDays * 86_400_000).toISOString()
      : promotion.endAt;
    const expiresAt = new Date(Math.min(Date.parse(daysExpiry), Date.parse(promotion.endAt))).toISOString();
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO user_coupons (id, user_id, promotion_id, expires_at) VALUES (?, ?, ?, ?)
    `).bind(id, member!.id, promotion.id, expiresAt).run();
    return ok({ id, promotionId: promotion.id, expiresAt, status: "available" }, "優惠券領取成功", 201);
  } catch (error) { return fail(error); }
}

export async function listMyCoupons(request: Request, env: Env): Promise<HandlerResult> {
  try {
    const member = await memberContext(request, env, true);
    await env.DB.prepare(`
      UPDATE user_coupons SET status = 'expired'
      WHERE user_id = ? AND status = 'available' AND datetime(expires_at) < CURRENT_TIMESTAMP
    `).bind(member!.id).run();
    const result = await env.DB.prepare(`
      SELECT coupon.id, coupon.promotion_id AS promotionId,
        promotion.name, promotion.description,
        promotion.discount_type AS discountType, promotion.discount_value AS discountValue,
        promotion.min_order_amount AS minOrderAmount, promotion.max_discount AS maxDiscount,
        promotion.scope_type AS scopeType, promotion.start_at AS startAt,
        coupon.expires_at AS expiresAt,
        coupon.status, coupon.received_at AS receivedAt, coupon.used_at AS usedAt
      FROM user_coupons coupon
      INNER JOIN promotions promotion ON promotion.id = coupon.promotion_id
      WHERE coupon.user_id = ?
      ORDER BY CASE coupon.status WHEN 'available' THEN 0 WHEN 'used' THEN 1 ELSE 2 END, coupon.expires_at ASC
    `).bind(member!.id).all();
    return ok(result.results, "我的優惠券載入成功");
  } catch (error) { return fail(error); }
}

export async function validateCode(request: Request, env: Env): Promise<HandlerResult> {
  try {
    const body = await bodyOf(request);
    const member = await memberContext(request, env);
    const cart = await priceCart(env, body.items);
    const method = (["home", "store", "express"].includes(String(body.shippingMethod)) ? body.shippingMethod : "home") as ShippingMethod;
    const shipping = shippingAmount(method, cart.subtotal);
    const applied = await resolveApplied(env, member, cart, shipping, body.code, null);
    if (!applied) throw new PromotionError("INVALID_COUPON");
    return ok(previewData(cart, shipping, applied), "優惠碼套用成功");
  } catch (error) { return fail(error); }
}

export async function validateUserCoupon(request: Request, env: Env): Promise<HandlerResult> {
  try {
    const body = await bodyOf(request);
    const member = await memberContext(request, env, true);
    const cart = await priceCart(env, body.items);
    const method = (["home", "store", "express"].includes(String(body.shippingMethod)) ? body.shippingMethod : "home") as ShippingMethod;
    const shipping = shippingAmount(method, cart.subtotal);
    const applied = await resolveApplied(env, member, cart, shipping, null, body.userCouponId);
    if (!applied || !applied.userCouponId) throw new PromotionError("INVALID_COUPON");
    return ok(previewData(cart, shipping, applied), "會員優惠券套用成功");
  } catch (error) { return fail(error); }
}

export async function createPromotionOrder(request: Request, env: Env): Promise<HandlerResult> {
  try {
    const body = await bodyOf(request);
    const member = await memberContext(request, env, true);
    const recipientName = typeof body.recipientName === "string" ? body.recipientName.trim() : "";
    const recipientPhone = typeof body.recipientPhone === "string" ? body.recipientPhone.trim() : "";
    const orderNote = typeof body.orderNote === "string" ? body.orderNote.trim() : "";
    if (!recipientName || recipientName.length > 80 || !/^09\d{8}$/.test(recipientPhone) || orderNote.length > 1000) {
      throw new PromotionError("INVALID_CART", 400, "收件人資料格式不正確");
    }
    const storedCart = await env.DB.prepare(`
      SELECT product_id AS productId, variant_id AS variantId, quantity
      FROM member_cart_items
      WHERE member_id = ?
      ORDER BY created_at ASC
    `).bind(member!.id).all<OrderItemInput>();
    if (!Array.isArray(body.items) || !body.items.every(isItem) || body.items.length !== storedCart.results.length) {
      throw new PromotionError("INVALID_CART", 409, "購物車內容已更新，請重新確認後再結帳");
    }
    const submittedItems = body.items as Array<OrderItemInput & { specifications?: unknown }>;
    const submittedByVariant = new Map(submittedItems.map((item) => [item.variantId ?? item.productId, item]));
    const cartMatches = storedCart.results.every((item) => {
      const submitted = submittedByVariant.get(item.variantId ?? item.productId);
      return submitted?.productId === item.productId
        && submitted.variantId === item.variantId
        && submitted.quantity === item.quantity
        && Array.isArray(submitted.specifications);
    });
    if (!cartMatches) throw new PromotionError("INVALID_CART", 409, "購物車內容已更新，請重新確認後再結帳");
    const cart = await priceCart(env, storedCart.results);
    const method = (["home", "store", "express"].includes(String(body.shippingMethod)) ? body.shippingMethod : "home") as ShippingMethod;
    const pickupStoreInput = body.pickupStore && typeof body.pickupStore === "object" ? body.pickupStore as Record<string, unknown> : null;
    const pickupStoreId = typeof pickupStoreInput?.storeId === "string" ? pickupStoreInput.storeId.trim() : "";
    if (method === "store" && !pickupStoreId) throw new PromotionError("PICKUP_STORE_REQUIRED");
    const pickupStore = method === "store" ? await findSevenElevenStore(env, pickupStoreId) : null;
    if (method === "store" && !pickupStore) throw new PromotionError("PICKUP_STORE_INVALID", 409);
    const bankTransfer = await env.DB.prepare(`SELECT bank_code AS bankCode, bank_name AS bankName,
      branch_name AS branchName, account_name AS accountName, account_number AS accountNumber, note
      FROM bank_transfer_settings WHERE id = 'default'`)
      .first<{ bankCode: string; bankName: string; branchName: string; accountName: string; accountNumber: string; note: string }>();
    if (!bankTransfer) throw new PromotionError("BANK_TRANSFER_NOT_CONFIGURED", 503);
    const shipping = shippingAmount(method, cart.subtotal);
    const applied = await resolveApplied(env, member, cart, shipping, body.couponCode, body.userCouponId);
    const totals = previewData(cart, shipping, applied);
    const orderId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [env.DB.prepare(`
      INSERT INTO orders (
        id, status, currency, total, member_id, customer_email,
        subtotal, discount_amount, shipping_amount, total_amount,
        promotion_id, promotion_name, coupon_code, user_coupon_id,
        shipping_method, pickup_store_provider, pickup_store_id,
        pickup_store_name, pickup_store_address, pickup_store_phone,
        recipient_name, recipient_phone, order_note,
        remitting_bank, transfer_account_last_five,
        payment_status, shipping_status,
        bank_code, bank_name, bank_branch_name, bank_account_name,
        bank_account_number, bank_transfer_note
      ) VALUES (
        ?, 'pending', 'TWD', ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        'pending', 'unfulfilled',
        ?, ?, ?, ?,
        ?, ?
      )
    `).bind(
      orderId, totals.total, member?.id ?? null, member?.email ?? null,
      totals.subtotal, totals.discount + totals.shippingDiscount, totals.shipping, totals.total,
      applied?.promotion.id ?? null, applied?.promotion.name ?? null,
      applied?.code?.code ?? null, applied?.userCouponId ?? null,
      method, pickupStore ? "UNIMART" : null, pickupStore?.storeId ?? null,
      pickupStore?.storeName ?? null, pickupStore?.storeAddress ?? null, pickupStore?.storePhone ?? null,
      recipientName, recipientPhone, orderNote,
      "", "",
      bankTransfer.bankCode, bankTransfer.bankName, bankTransfer.branchName,
      bankTransfer.accountName, bankTransfer.accountNumber, bankTransfer.note,
    )];
    for (const item of cart.items) {
      statements.push(
        env.DB.prepare(`
          INSERT INTO order_items (
            id, order_id, product_id, variant_id, product_name, product_image_url,
            specifications_json, unit_price, quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(), orderId, item.id, item.variantId, item.name,
          item.imageUrl, item.specificationsJson, item.price, item.quantity,
        ),
        env.DB.prepare(`
          UPDATE products SET inventory = inventory - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND inventory >= ?
        `).bind(item.quantity, item.id, item.quantity),
        env.DB.prepare(`
          UPDATE product_variants SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND stock - reserved >= ?
        `).bind(item.quantity, item.variantId, item.quantity),
      );
    }
    if (applied && member) statements.push(env.DB.prepare(`
      INSERT INTO coupon_usages (
        id, user_id, promotion_id, user_coupon_id, coupon_code_id, order_id, discount_amount, promotion_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(), member.id, applied.promotion.id, applied.userCouponId,
      applied.code?.id ?? null, orderId, applied.discount + applied.shippingDiscount, applied.promotion.revision,
    ));
    statements.push(env.DB.prepare("DELETE FROM member_cart_items WHERE member_id = ?").bind(member!.id));
    await env.DB.batch(statements);
    return ok({
      id: orderId,
      status: "pending",
      currency: "TWD",
      paymentMethod: "bank_transfer",
      bankTransfer,
      items: cart.items.map((item) => ({
        productId: item.id,
        variantId: item.variantId,
        name: item.name,
        imageUrl: item.imageUrl,
        specifications: JSON.parse(item.specificationsJson || "[]") as unknown[],
        price: item.price,
        quantity: item.quantity,
        total: item.lineTotal,
      })),
      ...totals,
    }, "訂單建立成功", 201);
  } catch (error) { return fail(error, "訂單建立暫時無法使用"); }
}

export async function grantNewMemberCoupons(env: Env, memberId: string): Promise<void> {
  const result = await env.DB.prepare(`
    SELECT ${promotionColumns} FROM promotions
    WHERE promotion_method = 'coupon' AND member_type = 'new_member'
      AND auto_grant_new_member = 1 AND status = 'active'
      AND datetime(start_at) <= CURRENT_TIMESTAMP AND datetime(end_at) >= CURRENT_TIMESTAMP
  `).all<PromotionRow>();
  for (const promotion of result.results) {
    const daysExpiry = promotion.couponValidDays
      ? new Date(Date.now() + promotion.couponValidDays * 86_400_000).toISOString()
      : promotion.endAt;
    const expiresAt = new Date(Math.min(Date.parse(daysExpiry), Date.parse(promotion.endAt))).toISOString();
    try {
      await env.DB.prepare(`INSERT INTO user_coupons (id, user_id, promotion_id, expires_at) VALUES (?, ?, ?, ?)`)
        .bind(crypto.randomUUID(), memberId, promotion.id, expiresAt).run();
    } catch (error) {
      if (!(error instanceof Error) || (!error.message.includes("ALREADY_CLAIMED") && !error.message.includes("CLAIM_LIMIT_REACHED"))) throw error;
    }
  }
}
