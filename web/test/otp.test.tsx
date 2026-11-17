import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OtpForm } from "../src/AuthPages";
import { json, session } from "./fixtures";

type Call = [string, RequestInit];
const body = (fetcher: ReturnType<typeof vi.fn>, index: number) => JSON.parse(String((fetcher.mock.calls[index] as Call)[1].body));
async function sendCode(user = userEvent.setup()) {
  await user.type(screen.getByLabelText("Email address"), "you@example.com");
  await user.click(screen.getByRole("button", { name: "Continue with email" }));
  return screen.findByLabelText("Verification code");
}

describe("email sign-in", () => {
  it("requests a code, focuses the code field and signs in on the sixth digit without another click", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetcher);
    const onSession = vi.fn();
    const onStage = vi.fn();
    const user = userEvent.setup();
    render(<OtpForm onSession={onSession} onStage={onStage} />);
    const code = await sendCode(user);
    expect(onStage).toHaveBeenLastCalledWith("you@example.com");
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(code).toHaveAttribute("inputmode", "numeric");
    expect(body(fetcher, 0)).toEqual({ email: "you@example.com" });
    await user.type(code, "12345");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
    await user.type(code, "6");
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body(fetcher, 1)).toEqual({ email: "you@example.com", code: "123456" });
  });

  it("accepts a pasted code with spaces and ignores anything that is not a digit", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetcher);
    const onSession = vi.fn();
    render(<OtpForm onSession={onSession} />);
    const code = await sendCode();
    fireEvent.change(code, { target: { value: "123 456" } });
    await waitFor(() => expect(onSession).toHaveBeenCalled());
    expect(body(fetcher, 1).code).toBe("123456");
  });

  it("explains a wrong code in plain words, clears the field and lets the next six digits try again", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json({ error: "invalid_code" }, 400))
      .mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetcher);
    const onSession = vi.fn();
    const user = userEvent.setup();
    render(<OtpForm onSession={onSession} />);
    const code = await sendCode(user);
    await user.type(code, "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That code is invalid or has expired");
    expect(code).toHaveValue("");
    expect(code).toHaveFocus();
    expect(onSession).not.toHaveBeenCalled();
    await user.type(code, "654321");
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the digits after a connection failure so Sign in can retry them", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetcher);
    const onSession = vi.fn();
    const user = userEvent.setup();
    render(<OtpForm onSession={onSession} />);
    const code = await sendCode(user);
    await user.type(code, "123456");
    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    expect(code).toHaveValue("123456");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith(session));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns to the email step with the address kept", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })));
    const onStage = vi.fn();
    const user = userEvent.setup();
    render(<OtpForm onSession={vi.fn()} onStage={onStage} />);
    await sendCode(user);
    await user.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText("Email address")).toHaveValue("you@example.com");
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
    expect(onStage).toHaveBeenLastCalledWith(null);
  });

  it("shows rate limits and does not advance to the code step", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "rate_limited" }, 429)));
    const user = userEvent.setup();
    render(<OtpForm onSession={vi.fn()} />);
    await user.type(screen.getByLabelText("Email address"), "you@example.com");
    await user.click(screen.getByRole("button", { name: "Continue with email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
  });
});

async function sendCodeWithFakeTimers() {
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "you@example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with email" })); });
}

it("counts down before a resend, then sends to the same address without leaving the code step", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  render(<OtpForm onSession={vi.fn()} />);
  await sendCodeWithFakeTimers();
  expect(screen.getByRole("button", { name: "Resend code in 30s" })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(screen.getByRole("button", { name: "Resend code in 29s" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123" } });
  for (let i = 0; i < 29; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend code" })); });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(body(fetcher, 1)).toEqual({ email: "you@example.com" });
  expect(screen.getByLabelText("Verification code")).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent("Use the most recent email");
  expect(screen.getByRole("button", { name: "Resend code in 30s" })).toBeDisabled();
});

it("keeps the code step and announces a server rate limit on a resend", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({ error: "rate_limited" }, 429)));
  render(<OtpForm onSession={vi.fn()} />);
  await sendCodeWithFakeTimers();
  for (let i = 0; i < 30; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend code" })); });
  expect(screen.getByRole("alert")).toHaveTextContent("Too many attempts");
  expect(screen.getByLabelText("Verification code")).toBeInTheDocument();
});
