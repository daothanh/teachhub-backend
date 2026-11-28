import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppException, type Env } from '@teachhub/core';
import { REDIS } from '@teachhub/infra';
import type { AppleAndroidCallback } from '../http/auth.schemas.js';
import {
  APPLE_ANDROID_SERVICES_ID,
  AppleIdTokenService,
} from './apple-id-token.service.js';

const APP_LINK = 'dayhoc://auth/apple/callback';
const STATE_TTL_SEC = 300;
const CODE_TTL_SEC = 60;
const randomOpaque = () => randomBytes(32).toString('base64url');
const stateKey = (state: string) => `apple:android:state:${state}`;
const codeKey = (code: string) => `apple:android:code:${code}`;

// Mỗi state chỉ tạo được một mã, kể cả khi callback thành công và hủy đến đồng thời.
const COMPLETE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if not redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3], 'NX') then return 0 end
redis.call('DEL', KEYS[1])
return 1`;

// Verifier sai không đốt mã; chỉ một yêu cầu đúng có thể lấy kết quả.
const REDEEM = `
local value = redis.call('GET', KEYS[1])
if not value or string.sub(value, 1, 43) ~= ARGV[1] then return nil end
redis.call('DEL', KEYS[1])
return string.sub(value, 44)`;

type Result =
  | { status: 'cancelled' }
  | {
      status: 'verified';
      subject: string;
      email: string | null;
      name: string | null;
    };

const appleUserSchema = z.object({
  name: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  }),
});

function displayName(user: string | undefined): string | null {
  if (!user) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(user);
  } catch {
    return null;
  }
  const { data } = appleUserSchema.safeParse(parsed);
  if (!data) return null;
  const { firstName, lastName } = data.name;
  // Form không ký tên; chỉ giữ ký tự phù hợp để hiển thị. Email trong form luôn bị bỏ qua.
  const name = `${firstName ?? ''} ${lastName ?? ''}`
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{Nd} .’'-]/gu, ' ')
    .replace(/ +/g, ' ')
    .trim();
  return name.length <= 120 && /\p{L}/u.test(name) ? name : null;
}

@Injectable()
export class AppleAndroidService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly apple: AppleIdTokenService,
  ) {}

  async start(challenge: string) {
    this.requireEnabled();
    const state = randomOpaque();
    const nonce = randomOpaque();
    const stored = await this.redisCall(() =>
      this.redis.set(stateKey(state), nonce + challenge, 'EX', STATE_TTL_SEC, 'NX'),
    );
    if (!stored) throw new AppException('SERVICE_UNAVAILABLE');

    const url = new URL('https://appleid.apple.com/auth/authorize');
    url.search = new URLSearchParams({
      client_id: APPLE_ANDROID_SERVICES_ID,
      redirect_uri: this.config.get('APPLE_ANDROID_RETURN_URL'),
      response_type: 'code id_token',
      response_mode: 'form_post',
      scope: 'name email',
      state,
      nonce,
    }).toString();
    return { authorization_url: url.toString(), expires_in: STATE_TTL_SEC };
  }

  async callback(form: AppleAndroidCallback): Promise<string> {
    this.requireEnabled();
    const key = stateKey(form.state);
    const pending = await this.redisCall(() => this.redis.get(key));
    if (pending === null) throw new AppException('UNAUTHENTICATED');
    const nonce = pending.slice(0, 43);
    const challenge = pending.slice(43);

    let result: Result;
    if (form.error) {
      if (form.code || form.id_token || form.user !== undefined) {
        throw new AppException('BAD_REQUEST');
      }
      result = { status: 'cancelled' };
    } else {
      if (!form.code || !form.id_token) throw new AppException('BAD_REQUEST');
      const identity = await this.apple.verifyAndroid(
        form.id_token,
        nonce,
        form.code,
      );
      result = {
        status: 'verified',
        subject: identity.subject,
        email: identity.email,
        name: displayName(form.user),
      };
    }

    const code = randomOpaque();
    const completed = await this.redisCall(() =>
      this.redis.eval(
        COMPLETE,
        2,
        key,
        codeKey(code),
        pending,
        challenge + JSON.stringify(result),
        CODE_TTL_SEC,
      ),
    );
    if (completed !== 1) throw new AppException('UNAUTHENTICATED');
    return `${APP_LINK}?code=${code}`;
  }

  async redeem(code: string, verifier: string): Promise<Result> {
    this.requireEnabled();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const result = await this.redisCall(() =>
      this.redis.eval(REDEEM, 1, codeKey(code), challenge),
    );
    if (typeof result !== 'string') throw new AppException('UNAUTHENTICATED');
    return JSON.parse(result) as Result;
  }

  private requireEnabled(): void {
    if (!this.config.get('APPLE_ANDROID_ENABLED')) {
      throw new AppException('NOT_FOUND');
    }
  }

  private async redisCall<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      throw new AppException('SERVICE_UNAVAILABLE');
    }
  }
}
