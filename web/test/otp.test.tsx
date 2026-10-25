import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OtpForm } from "../src/AuthPages";
import { json, session } from "./fixtures";

describe("email sign-in", () => {
  it("requests a code, labels and focuses the OTP input, then verifies six digits", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ ok: true }))
      .mockResolvedValueOnce(json(session));
    vi.stubGlobal("fetch", fetcher);
    const onSession = vi.fn();
    const user = userEvent.setup();
    render(<OtpForm onSession={onSession} />);
    await user.type(screen.getByLabelText("Email address"), "you@example.com");
    await user.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    const code = await screen.findByLabelText("Verification code");
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute("autocomplete", "one-time-code");
    expect(fetcher.mock.calls[0][1].body).toBe(
      JSON.stringify({ email: "you@example.com" }),
    );
    await user.type(code, "123456");
    await user.click(screen.getByRole("button", { name: "Verify & sign in" }));
    expect(fetcher.mock.calls[1][1].body).toBe(
      JSON.stringify({ email: "you@example.com", code: "123456" }),
    );
    expect(onSession).toHaveBeenCalledWith(session);
  });
  it("announces invalid codes and permits requesting another code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ ok: true }))
        .mockResolvedValueOnce(json({ error: "invalid_code" }, 400)),
    );
    const user = userEvent.setup();
    render(<OtpForm onSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "you@example.com" },
    });
    await user.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    await user.type(
      await screen.findByLabelText("Verification code"),
      "000000",
    );
    await user.click(screen.getByRole("button", { name: "Verify & sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid or has expired",
    );
    await user.click(screen.getByRole("button", { name: /Use another email/ }));
    expect(screen.getByLabelText("Email address")).toBeInTheDocument();
  });
  it("shows rate limits and does not advance to verification", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: "rate_limited" }, 429)),
    );
    const user = userEvent.setup();
    render(<OtpForm onSession={vi.fn()} />);
    await user.type(screen.getByLabelText("Email address"), "you@example.com");
    await user.click(
      screen.getByRole("button", { name: "Continue with email" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Too many attempts",
    );
    expect(
      screen.queryByLabelText("Verification code"),
    ).not.toBeInTheDocument();
  });
});
