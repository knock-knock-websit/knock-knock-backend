import type { Env } from "./types";
import { grantNewMemberCoupons } from "./promotions";

type MemberRow = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified_at: string | null;
  status: "active" | "suspended";
};

type HandlerResult = { body: unknown; status?: number };
type MemberGender = "undisclosed" | "female" | "male" | "other";

type MemberProfile = {
  name: string;
  email: string;
  birthday: string | null;
  gender: MemberGender;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let value = "";
  bytes.forEach((byte) => { value += String.fromCharCode(byte); });
  return btoa(value);
}

function randomDigits(): string {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String((values[0]! % 900000) + 100000);
}

function randomToken(): string {
  const values = new Uint8Array(32);
  crypto.getRandomValues(values);
  return base64(values).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256(value: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function hashPassword(password: string, salt = randomToken()): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 210_000 },
    key,
    256,
  );
  return `pbkdf2-sha256$210000$${salt}$${base64(new Uint8Array(derived))}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, iterations, salt, expected] = stored.split("$");
  if (algorithm !== "pbkdf2-sha256" || iterations !== "210000" || !salt || !expected) return false;
  const actual = (await hashPassword(password, salt)).split("$")[3]!;
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function authSecret(env: Env): string {
  return env.AUTH_SECRET?.trim() || "knock-knock-local-development-only";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]!);
}

async function codeHash(env: Env, memberId: string, code: string): Promise<string> {
  return sha256(`${authSecret(env)}:${memberId}:${code}`);
}

async function sendVerificationEmail(env: Env, email: string, name: string, code: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.ENVIRONMENT === "production") throw new Error("尚未設定 Email 寄送服務");
    console.info(`[knock-knock] Verification code for ${email}: ${code}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "KNOCK-KNOCK <members@knock-knock.tw>",
      to: [email],
      subject: "敲敲會員 Email 驗證碼",
      html: `<div style="font-family:sans-serif;line-height:1.7"><h2>${escapeHtml(name)}，歡迎加入敲敲</h2><p>你的 Email 驗證碼是：</p><p style="font-size:30px;font-weight:700;letter-spacing:8px">${code}</p><p>驗證碼將於 10 分鐘後失效。若非本人操作，請忽略此信。</p></div>`,
    }),
  });
  if (!response.ok) throw new Error(`Email service returned ${response.status}`);
}

function frontendUrl(env: Env): string {
  const configured = env.FRONTEND_ORIGIN?.split(",")[0]?.trim();
  return (configured && configured !== "*" ? configured : "http://localhost:3000").replace(/\/$/, "");
}

async function sendPasswordResetEmail(env: Env, email: string, name: string, resetUrl: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.ENVIRONMENT === "production") throw new Error("尚未設定 Email 寄送服務");
    console.info(`[knock-knock] Password reset URL for ${email}: ${resetUrl}`);
    return;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "KNOCK-KNOCK <members@knock-knock.tw>",
      to: [email],
      subject: "敲敲會員重設密碼",
      html: `<div style="font-family:sans-serif;line-height:1.7"><h2>${escapeHtml(name)}，重設你的會員密碼</h2><p>請點選下方連結設定新密碼：</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 20px;background:#171717;color:#fff;text-decoration:none">設定新密碼</a></p><p>連結將於 30 分鐘後失效，且只能使用一次。若非本人操作，請忽略此信。</p></div>`,
    }),
  });
  if (!response.ok) throw new Error(`Email service returned ${response.status}`);
}

async function createVerification(env: Env, member: Pick<MemberRow, "id" | "email" | "name">) {
  const code = randomDigits();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.prepare(`
    INSERT INTO member_email_verifications (member_id, code_hash, expires_at, attempts, sent_at)
    VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(member_id) DO UPDATE SET
      code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = CURRENT_TIMESTAMP
  `).bind(member.id, await codeHash(env, member.id, code), expiresAt).run();
  await sendVerificationEmail(env, member.email, member.name, code);
  return { expiresAt, developmentCode: env.ENVIRONMENT === "production" ? undefined : code };
}

async function parseBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function ok(data: unknown, message: string, status = 200): HandlerResult {
  return { body: { success: true, message, data }, status };
}

function fail(message: string, status: number, code?: string): HandlerResult {
  return { body: { success: false, message, ...(code ? { code } : {}), data: null }, status };
}

async function register(request: Request, env: Env): Promise<HandlerResult> {
  const body = await parseBody(request);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!name || name.length > 80) return fail("請輸入正確的會員姓名", 400);
  if (!emailPattern.test(email) || email.length > 254) return fail("請輸入正確的 Email 格式", 400);
  if (password.length < 8 || password.length > 128) return fail("密碼需為 8 至 128 個字元", 400);

  const existing = await env.DB.prepare("SELECT id FROM members WHERE email = ?").bind(email).first();
  if (existing) return fail("此帳號已註冊", 200, "EMAIL_EXISTS");
  const member: MemberRow = {
    id: crypto.randomUUID(), name, email, password_hash: await hashPassword(password),
    email_verified_at: null, status: "active",
  };
  await env.DB.prepare(`
    INSERT INTO members (id, name, email, password_hash) VALUES (?, ?, ?, ?)
  `).bind(member.id, member.name, member.email, member.password_hash).run();
  try {
    const verification = await createVerification(env, member);
    return ok({ email, ...verification }, "驗證碼已寄出", 200);
  } catch (error) {
    console.error("Unable to send verification email", error);
    return ok({ email, emailSent: false }, "帳號已建立，但驗證信暫時無法寄出，請在驗證頁重新寄送", 201);
  }
}

async function resend(request: Request, env: Env): Promise<HandlerResult> {
  const body = await parseBody(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const member = await env.DB.prepare(`
    SELECT id, name, email, password_hash, email_verified_at, status FROM members WHERE email = ?
  `).bind(email).first<MemberRow>();
  if (!member || member.email_verified_at) return ok(null, "若帳號尚未驗證，新的驗證碼將寄至信箱");
  const recent = await env.DB.prepare(`
    SELECT MAX(1, 60 - (unixepoch('now') - unixepoch(sent_at))) AS retryAfterSeconds
    FROM member_email_verifications
    WHERE member_id = ? AND sent_at > datetime('now', '-60 seconds')
  `).bind(member.id).first<{ retryAfterSeconds: number }>();
  if (recent) {
    return ok(
      { email, retryAfterSeconds: recent.retryAfterSeconds },
      `請等待 ${recent.retryAfterSeconds} 秒後再重新寄送`,
    );
  }
  try {
    const verification = await createVerification(env, member);
    return ok({ email, ...verification, retryAfterSeconds: 60 }, "新的驗證碼已寄出");
  } catch (error) {
    console.error("Unable to resend verification email", error);
    return fail("驗證信暫時無法寄出，請稍後再試", 502);
  }
}

async function verifyEmail(request: Request, env: Env): Promise<HandlerResult> {
  const body = await parseBody(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!emailPattern.test(email) || !/^\d{6}$/.test(code)) return fail("驗證碼格式不正確", 400);
  const member = await env.DB.prepare("SELECT id, email_verified_at FROM members WHERE email = ?").bind(email)
    .first<Pick<MemberRow, "id" | "email_verified_at">>();
  if (!member) return fail("驗證碼不正確或已失效", 400);
  if (member.email_verified_at) return ok(null, "Email 已完成驗證");
  const verification = await env.DB.prepare(`
    SELECT code_hash, expires_at, attempts FROM member_email_verifications WHERE member_id = ?
  `).bind(member.id).first<{ code_hash: string; expires_at: string; attempts: number }>();
  if (!verification || Date.parse(verification.expires_at) <= Date.now() || verification.attempts >= 5) {
    return fail("驗證碼不正確或已失效，請重新寄送", 400);
  }
  if (verification.code_hash !== await codeHash(env, member.id, code)) {
    await env.DB.prepare("UPDATE member_email_verifications SET attempts = attempts + 1 WHERE member_id = ?")
      .bind(member.id).run();
    return fail("驗證碼不正確或已失效", 400);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE members SET email_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(member.id),
    env.DB.prepare("DELETE FROM member_email_verifications WHERE member_id = ?").bind(member.id),
  ]);
  await grantNewMemberCoupons(env, member.id);
  return ok(null, "Email 驗證成功");
}

async function login(request: Request, env: Env): Promise<HandlerResult> {
  const body = await parseBody(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const member = emailPattern.test(email) ? await env.DB.prepare(`
    SELECT id, name, email, password_hash, email_verified_at, status FROM members WHERE email = ?
  `).bind(email).first<MemberRow>() : null;
  if (!member || !await verifyPassword(password, member.password_hash)) return fail("帳號或密碼不正確", 401);
  if (member.status === "suspended") return fail("此會員帳號已停權", 403, "ACCOUNT_SUSPENDED");
  if (!member.email_verified_at) return fail("請先完成 Email 驗證", 403, "EMAIL_NOT_VERIFIED");
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(`
    INSERT INTO member_sessions (id, member_id, token_hash, expires_at) VALUES (?, ?, ?, ?)
  `).bind(crypto.randomUUID(), member.id, await sha256(token), expiresAt).run();
  return ok({
    accessToken: token,
    expiresAt,
    user: { id: member.id, account: member.email, name: member.name, type: "email", verified: true },
  }, "登入成功");
}

async function requestPasswordReset(request: Request, env: Env): Promise<HandlerResult> {
  const body = await parseBody(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!emailPattern.test(email)) return fail("請輸入正確的 Email 格式", 200);
  const genericMessage = "若此 Email 已註冊，重設密碼連結將寄至你的信箱";
  const member = await env.DB.prepare(`
    SELECT id, name, email, password_hash, email_verified_at, status FROM members WHERE email = ?
  `).bind(email).first<MemberRow>();
  if (!member || !member.email_verified_at || member.status !== "active") return ok(null, genericMessage);
  const recent = await env.DB.prepare(`
    SELECT 1 FROM member_password_resets
    WHERE member_id = ? AND sent_at > datetime('now', '-60 seconds')
  `).bind(member.id).first();
  if (recent) return ok(null, genericMessage);

  const token = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const resetUrl = `${frontendUrl(env)}/auth/reset-password?token=${encodeURIComponent(token)}`;
  await env.DB.prepare(`
    INSERT INTO member_password_resets (member_id, token_hash, expires_at, sent_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(member_id) DO UPDATE SET
      token_hash = excluded.token_hash, expires_at = excluded.expires_at, sent_at = CURRENT_TIMESTAMP
  `).bind(member.id, await sha256(token), expiresAt).run();
  try {
    await sendPasswordResetEmail(env, member.email, member.name, resetUrl);
  } catch (error) {
    console.error("Unable to send password reset email", error);
    await env.DB.prepare("DELETE FROM member_password_resets WHERE member_id = ?").bind(member.id).run();
  }
  return ok(
    env.ENVIRONMENT === "production" ? null : { developmentResetUrl: resetUrl },
    genericMessage,
  );
}

async function resetPassword(request: Request, env: Env): Promise<HandlerResult> {
  const body = await parseBody(request);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!token) return fail("重設密碼連結不正確或已失效", 200, "INVALID_RESET_TOKEN");
  if (password.length < 8 || password.length > 128) return fail("密碼需為 8 至 128 個字元", 200);
  const reset = await env.DB.prepare(`
    SELECT password_reset.member_id AS memberId
    FROM member_password_resets password_reset
    INNER JOIN members member ON member.id = password_reset.member_id
    WHERE password_reset.token_hash = ?
      AND datetime(password_reset.expires_at) > CURRENT_TIMESTAMP
      AND member.status = 'active'
  `).bind(await sha256(token)).first<{ memberId: string }>();
  if (!reset) return fail("重設密碼連結不正確或已失效", 200, "INVALID_RESET_TOKEN");
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE members SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).bind(await hashPassword(password), reset.memberId),
    env.DB.prepare("DELETE FROM member_password_resets WHERE member_id = ?").bind(reset.memberId),
    env.DB.prepare(`
      UPDATE member_sessions SET revoked_at = CURRENT_TIMESTAMP
      WHERE member_id = ? AND revoked_at IS NULL
    `).bind(reset.memberId),
  ]);
  return ok(null, "密碼重設成功");
}

async function logout(request: Request, env: Env): Promise<HandlerResult> {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    await env.DB.prepare("UPDATE member_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
      .bind(await sha256(authorization.slice(7).trim())).run();
  }
  return ok(null, "登出成功");
}

export async function authenticatedMember(
  request: Request,
  env: Env,
): Promise<Pick<MemberRow, "id" | "email"> | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const tokenHash = await sha256(authorization.slice(7).trim());
  const member = await env.DB.prepare(`
    SELECT m.id, m.email
    FROM member_sessions session
    INNER JOIN members m ON m.id = session.member_id
    WHERE session.token_hash = ? AND session.revoked_at IS NULL
      AND datetime(session.expires_at) > CURRENT_TIMESTAMP AND m.status = 'active'
  `).bind(tokenHash).first<Pick<MemberRow, "id" | "email">>();
  if (member) {
    await env.DB.prepare("UPDATE member_sessions SET last_active_at = CURRENT_TIMESTAMP WHERE token_hash = ?")
      .bind(tokenHash).run();
  }
  return member;
}

export async function handleMemberAuth(request: Request, env: Env): Promise<HandlerResult | null> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/api/auth/register") return register(request, env);
  if (request.method === "POST" && path === "/api/auth/verify-email") return verifyEmail(request, env);
  if (request.method === "POST" && path === "/api/auth/resend-verification") return resend(request, env);
  if (request.method === "POST" && path === "/api/auth/login") return login(request, env);
  if (request.method === "POST" && path === "/api/auth/logout") return logout(request, env);
  if (request.method === "POST" && path === "/api/auth/request-password-reset") return requestPasswordReset(request, env);
  if (request.method === "POST" && path === "/api/auth/reset-password") return resetPassword(request, env);
  return null;
}

export async function memberOverview(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const result = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM orders WHERE member_id = ?) AS orderCount,
      (SELECT COUNT(*) FROM member_favorites WHERE member_id = ?) AS favoriteCount,
      (
        SELECT COUNT(*) FROM user_coupons coupon
        WHERE coupon.user_id = ? AND coupon.status = 'available'
          AND datetime(coupon.expires_at) >= CURRENT_TIMESTAMP
      ) AS availableCouponCount
  `).bind(member.id, member.id, member.id).first<{
    orderCount: number;
    favoriteCount: number;
    availableCouponCount: number;
  }>();
  return ok({
    orderCount: Number(result?.orderCount ?? 0),
    favoriteCount: Number(result?.favoriteCount ?? 0),
    availableCouponCount: Number(result?.availableCouponCount ?? 0),
  }, "會員總覽載入成功");
}

function validBirthday(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 &&
    date.getUTCDate() === day && year! >= 1900 && value <= new Date().toISOString().slice(0, 10);
}

export async function getMemberProfile(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const profile = await env.DB.prepare(`
    SELECT name, email, birthday, gender FROM members WHERE id = ?
  `).bind(member.id).first<MemberProfile>();
  return profile ? ok(profile, "個人資料載入成功") : fail("找不到會員資料", 404);
}

export async function updateMemberProfile(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const body = await parseBody(request);
  if (!body) return fail("個人資料格式不正確", 400);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const birthday = body.birthday === null || body.birthday === ""
    ? null
    : typeof body.birthday === "string" ? body.birthday.trim() : undefined;
  const gender = body.gender;
  if (!name || name.length > 80) return fail("姓名需為 1 至 80 個字元", 400);
  if (birthday === undefined || (birthday !== null && !validBirthday(birthday))) {
    return fail("生日格式不正確", 400);
  }
  if (!["undisclosed", "female", "male", "other"].includes(String(gender))) {
    return fail("性別格式不正確", 400);
  }
  if (body.email !== undefined &&
      (typeof body.email !== "string" || body.email.trim().toLowerCase() !== member.email)) {
    return fail("Email 不可修改", 400);
  }
  await env.DB.prepare(`
    UPDATE members
    SET name = ?, birthday = ?, gender = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(name, birthday, gender as MemberGender, member.id).run();
  return ok({ name, email: member.email, birthday, gender }, "個人資料已更新");
}

export async function changeMemberPassword(request: Request, env: Env): Promise<HandlerResult> {
  const member = await authenticatedMember(request, env);
  if (!member) return fail("請先登入會員", 401);
  const body = await parseBody(request);
  if (!body) return fail("密碼資料格式不正確", 400);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";
  if (!currentPassword) return fail("請輸入目前密碼", 400);
  if (newPassword.length < 8 || newPassword.length > 128) {
    return fail("新密碼需為 8 至 128 個字元", 400);
  }
  if (newPassword !== confirmPassword) return fail("兩次輸入的新密碼不一致", 400);
  if (currentPassword === newPassword) return fail("新密碼不可與目前密碼相同", 400);
  const credential = await env.DB.prepare(`
    SELECT password_hash AS passwordHash FROM members WHERE id = ?
  `).bind(member.id).first<{ passwordHash: string }>();
  if (!credential || !await verifyPassword(currentPassword, credential.passwordHash)) {
    return fail("目前密碼不正確", 400);
  }
  await env.DB.prepare(`
    UPDATE members SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(await hashPassword(newPassword), member.id).run();
  return ok(null, "密碼修改成功");
}
