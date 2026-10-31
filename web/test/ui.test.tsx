import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Modal } from "../src/ui";

it("keeps keyboard focus in the dialog, closes on Escape and restores the opener", async () => {
  function Screen() {
    const [open, setOpen] = useState(false);
    return <>
      <Button onClick={() => setOpen(true)}>New drive</Button>
      {open && <Modal title="Create a drive" onClose={() => setOpen(false)}>
        <label htmlFor="name">Drive name</label><Input id="name" />
        <Button onClick={() => setOpen(false)}>Save</Button>
      </Modal>}
    </>;
  }
  render(<Screen />);
  const user = userEvent.setup();
  const opener = screen.getByRole("button", { name: "New drive" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Create a drive" });
  expect(screen.getByLabelText("Drive name")).toHaveFocus();
  for (let i = 0; i < 5; i++) {
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  }
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});
