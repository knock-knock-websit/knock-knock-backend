import { authenticatedMember } from "./member-auth";
import type { Env } from "./types";

type HandlerResult = { body: unknown; status?: number };

type OrderRow = {
  id: string;
  memberName: string;
  customerEmail: string;
  recipientName: string;
  recipientPhone: string;
  total: number;
  subtotal: number;
  discount: number;
  shipping: number;
  paymentMethod: string;
  paymentStatus: string;
  shippingStatus: string;
  status: string;
  shippingMethod: string;
  pickupStoreName: string;
  pickupStoreId: string;
  pickupStoreAddress: string;
  pickupStorePhone: string;
  deliveryAddress: string;
  promotionName: string | null;
  couponCode: string | null;
  orderNote: string;
  trackingNo: string;
  bankCode: string;
  bankName: string;
  bankBranchName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankTransferNote: string;
  remittingBank: string;
  transferAccountLastFive: string;
  createdAt: string;
  updatedAt: string;
  itemsJson: string;
};

const columns = `
  orders.id,
  member.name AS memberName,
  orders.customer_email AS customerEmail,
  orders.recipient_name AS recipientName,
  orders.recipient_phone AS recipientPhone,
  orders.total_amount AS total,
  orders.subtotal,
  orders.discount_amount AS discount,
  orders.shipping_amount AS shipping,
  orders.payment_method AS paymentMethod,
  orders.payment_status AS paymentStatus,
  orders.shipping_status AS shippingStatus,
  orders.status,
  orders.shipping_method AS shippingMethod,
  COALESCE(orders.pickup_store_name, '') AS pickupStoreName,
  COALESCE(orders.pickup_store_id, '') AS pickupStoreId,
  COALESCE(orders.pickup_store_address, '') AS pickupStoreAddress,
  COALESCE(orders.pickup_store_phone, '') AS pickupStorePhone,
  COALESCE(orders.delivery_address, '') AS deliveryAddress,
  orders.promotion_name AS promotionName,
  orders.coupon_code AS couponCode,
  orders.order_note AS orderNote,
  orders.tracking_no AS trackingNo,
  orders.bank_code AS bankCode,
  orders.bank_name AS bankName,
  orders.bank_branch_name AS bankBranchName,
  orders.bank_account_name AS bankAccountName,
  orders.bank_account_number AS bankAccountNumber,
  orders.bank_transfer_note AS bankTransferNote,
  orders.remitting_bank AS remittingBank,
  orders.transfer_account_last_five AS transferAccountLastFive,
  orders.created_at AS createdAt,
  orders.updated_at AS updatedAt,
  COALESCE((
    SELECT json_group_array(json_object(
      'id', item.id,
      'productId', item.product_id,
      'variantId', item.variant_id,
      'name', item.product_name,
      'imageUrl', item.product_image_url,
      'specifications', json(item.specifications_json),
      'price', item.unit_price,
      'quantity', item.quantity
    ))
    FROM order_items item WHERE item.order_id = orders.id
  ), '[]') AS itemsJson
`;

function serialize(row: OrderRow) {
  const asUtc = (value: string) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const { status: _internalStatus, ...publicRow } = row;
  void _internalStatus;
  return {
    ...publicRow,
    createdAt: asUtc(row.createdAt),
    updatedAt: asUtc(row.updatedAt),
    orderNo: row.id.slice(0, 8).toUpperCase(),
    items: JSON.parse(row.itemsJson || "[]") as unknown[],
    itemsJson: undefined,
  };
}

export async function listMemberOrders(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return { body: { success: false, message: "請先登入會員", code: "AUTH_REQUIRED", data: null }, status: 401 };
  const params = new URL(request.url).searchParams;
  const paymentStatus = params.get("paymentStatus")?.trim() ?? "";
  const shippingStatus = params.get("shippingStatus")?.trim() ?? "";
  const page = Number(params.get("page") ?? "1");
  const pageSize = Number(params.get("pageSize") ?? "10");
  if ((paymentStatus && !["pending", "paid", "refunded", "failed"].includes(paymentStatus))
    || (shippingStatus && !["unfulfilled", "preparing", "shipped", "delivered"].includes(shippingStatus))
    || !Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return { body: { success: false, message: "訂單篩選或分頁格式不正確", data: null }, status: 400 };
  }
  const conditions = ["orders.member_id = ?"];
  const values: unknown[] = [member.id];
  if (paymentStatus) { conditions.push("orders.payment_status = ?"); values.push(paymentStatus); }
  if (shippingStatus) { conditions.push("orders.shipping_status = ?"); values.push(shippingStatus); }
  const where = conditions.join(" AND ");
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM orders WHERE ${where}`).bind(...values).first<{ total: number }>();
  const result = await env.DB.prepare(`
    SELECT ${columns}
    FROM orders
    INNER JOIN members member ON member.id = orders.member_id
    WHERE ${where}
    ORDER BY orders.created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...values, pageSize, (page - 1) * pageSize).all<OrderRow>();
  const total = Number(count?.total ?? 0);
  return { body: { success: true, message: "訂單紀錄載入成功", data: result.results.map(serialize), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } } };
}

export async function getMemberOrder(request: Request, env: Env, id: string): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return { body: { success: false, message: "請先登入會員", code: "AUTH_REQUIRED", data: null }, status: 401 };
  const row = await env.DB.prepare(`
    SELECT ${columns}
    FROM orders
    INNER JOIN members member ON member.id = orders.member_id
    WHERE orders.id = ? AND orders.member_id = ?
  `).bind(id, member.id).first<OrderRow>();
  if (!row) return { body: { success: false, message: "找不到訂單", data: null }, status: 404 };
  return { body: { success: true, message: "訂單詳情載入成功", data: serialize(row) } };
}

export async function updateMemberOrderRemittance(request: Request, env: Env, id: string): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return { body: { success: false, message: "請先登入會員", code: "AUTH_REQUIRED", data: null }, status: 401 };
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return { body: { success: false, message: "JSON 格式不正確", data: null }, status: 400 }; }
  const remittingBank = typeof body.remittingBank === "string" ? body.remittingBank.trim() : "";
  const transferAccountLastFive = typeof body.transferAccountLastFive === "string" ? body.transferAccountLastFive.trim() : "";
  if (!remittingBank || remittingBank.length > 100 || !/^\d{5}$/.test(transferAccountLastFive)) {
    return { body: { success: false, message: "請輸入轉出銀行與正確的帳號後五碼", data: null }, status: 400 };
  }
  const result = await env.DB.prepare(`
    UPDATE orders SET remitting_bank = ?, transfer_account_last_five = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND member_id = ? AND payment_status = 'pending' AND status != 'cancelled'
  `).bind(remittingBank, transferAccountLastFive, id, member.id).run();
  if (!result.meta.changes) return { body: { success: false, message: "此訂單無法更新匯款資料", data: null }, status: 409 };
  const row = await env.DB.prepare(`
    SELECT ${columns} FROM orders INNER JOIN members member ON member.id = orders.member_id
    WHERE orders.id = ? AND orders.member_id = ?
  `).bind(id, member.id).first<OrderRow>();
  return { body: { success: true, message: "匯款資料已送出，請等待審核", data: serialize(row!) } };
}
