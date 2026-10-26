import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { otpFromLog } from './helpers.mjs';

export async function desktopChecks(ctx) {
  const { root, work, api, endpoint, apiWorker, binary, check, json, until, start, stop, command, secrets } = ctx;
  const email = `desktop+${Date.now()}@example.invalid`;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let callbackURL;
  let daemon;
  const socket = join(work, 'desktop.sock');
  try {
    await check('desktop browser PKCE start + signed-in handoff code', async () => {
      const logOffset = apiWorker.stdout.length;
      await json(api, '/auth/otp/start', { body: { email } });
      let otp;
      await until(() => { otp = otpFromLog(apiWorker.stdout.slice(logOffset), email); return !!otp; }, 5000, 'desktop dev OTP missing');
      secrets.push(otp);
      const startURL = `${api}/auth/desktop/start?${new URLSearchParams({ state, code_challenge: challenge, code_challenge_method: 'S256' })}`;
      const response = await fetch(startURL, { redirect: 'manual' });
      assert.equal(response.status, 302);
      const destination = new URL(response.headers.get('location'));
      assert.equal(destination.pathname, '/desktop');
      assert.equal(destination.searchParams.get('state'), state);
      assert.equal(destination.searchParams.get('code_challenge'), challenge);
      if (process.env.E2E_DESKTOP_BROWSER === '1') {
        const browserContext = join(work, 'desktop-browser.json');
        await writeFile(browserContext, JSON.stringify({ startURL, email, otp }), { mode: 0o600 });
        console.log(`DESKTOP_BROWSER_READY ${work}`);
        const completed = join(work, 'desktop-browser-result.json');
        await until(async () => { try { await access(completed); return true; } catch { return false; } }, 240000, 'browser desktop handoff deadline exceeded');
        const result = JSON.parse(await readFile(completed, 'utf8'));
        assert(result.code, 'browser did not return a handoff code');
        callbackURL = `uls://auth/callback#${new URLSearchParams({ code: result.code, state })}`;
        secrets.push(result.code);
      } else {
        const session = await json(api, '/auth/otp/verify', { body: { email, code: otp } });
        secrets.push(session.accessToken, session.refreshToken);
        const { code } = await json(api, '/auth/desktop/code', { token: session.accessToken, body: { state, codeChallenge: challenge } });
        secrets.push(code);
        callbackURL = `uls://auth/callback#${new URLSearchParams({ code, state })}`;
      }
      return process.env.E2E_DESKTOP_BROWSER === '1' ? 'real browser signed in and issued PKCE code' : 'real local Worker OTP session and desktop code';
    });
    await check('desktop Swift PKCE exchange + deferred handoff + real daemon sign-out', async () => {
      assert(callbackURL, 'desktop browser code required');
      daemon = start(binary, ['daemon', '--state-dir', join(work, 'desktop-state'), '--socket', socket, '--secret-store', 'memory'], { ULS_ENDPOINT: endpoint, RUST_LOG: 'warn' });
      await until(async () => { try { await access(socket); return true; } catch { return false; } }, 5000, 'desktop daemon socket missing');
      const contextPath = join(work, 'desktop-swift.json');
      await writeFile(contextPath, JSON.stringify({ api, callbackURL, state, verifier, socket }), { mode: 0o600 });
      const result = await command('/bin/bash', [join(root, 'mac/scripts/test.sh'), '--filter', 'DesktopWorkerTests'], { ULS_DESKTOP_TEST_CONTEXT: contextPath, ULS_TEST_KEYCHAIN: '1' }, 180000);
      assert.equal(result.code, 0, `desktop Swift acceptance failed: ${result.stdout.slice(-1200)} ${result.stderr.slice(-1200)}`);
      assert.match(result.stdout + result.stderr, /1 test.*passed/);
      return 'production Swift exchange/parser; isolated test Keychain deferred/retry; real socket auth, drives and sign-out; replay rejected';
    });
  } finally {
    if (daemon) await stop(daemon);
  }
}
