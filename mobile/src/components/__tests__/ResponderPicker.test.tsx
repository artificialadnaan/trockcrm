import React, { useState } from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ResponderPicker, matchResponders } from "../ResponderPicker";
import type { FieldResponderOption, FieldResponderRole } from "../../api/types";

// A tiny controlled host so the picker's `value` tracks typing exactly like the real (dispatch-backed) sites —
// the suggestion filter reads `value`, so an uncontrolled render would freeze it at "". onChange is spied, and
// it forwards BOTH arguments: the responder argument is the whole point of the picker (it is what lets the
// draft record WHICH roster person was chosen), so a host that swallowed it would hide every regression in it.
function ControlledPicker({
  onChange,
  role = "superintendent",
  responders,
  error = null,
  initial = "",
  responderId = null,
}: {
  onChange: (name: string, responder: FieldResponderOption | null) => void;
  role?: FieldResponderRole;
  responders: FieldResponderOption[];
  error?: string | null;
  initial?: string;
  responderId?: string | null;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ResponderPicker
      value={value}
      onChange={(name, responder) => {
        setValue(name);
        onChange(name, responder);
      }}
      role={role}
      responders={responders}
      error={error}
      responderId={responderId}
    />
  );
}

const roster: FieldResponderOption[] = [
  { id: "u1", name: "James Helms", email: "james@trock.test", role: "superintendent" },
  { id: "u2", name: "Jamal Wright", email: "jamal@trock.test", role: "superintendent" },
  { id: "u3", name: "Tim Mitchell", email: "tim@trock.test", role: "project_manager" },
];

const INPUT_LABEL = "Superintendent name";

describe("matchResponders", () => {
  it("filters to the role, matches name substrings case-insensitively, caps at 6", () => {
    expect(matchResponders(roster, "superintendent", "jam").map((r) => r.id)).toEqual(["u1", "u2"]);
    // a PM-role match is excluded from a superintendent query even if the name matches
    expect(matchResponders(roster, "superintendent", "tim")).toEqual([]);
    // blank query shows the full role roster
    expect(matchResponders(roster, "superintendent", "").map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  it("excludes an entry whose name exactly equals the current value ONLY when THAT row is the pick", () => {
    // With that exact row picked, it has nothing to offer — the user already selected precisely it.
    expect(matchResponders(roster, "superintendent", "James Helms", { pickedId: "u1" })).toEqual([]);
    expect(matchResponders(roster, "superintendent", "james helms", { pickedId: "u1" })).toEqual([]);
    // With NO pick recorded, the row MUST stay offered. Otherwise a user who types the name (or edits a picked
    // name and undoes the edit, which clears the pick) can never record it: the card would display that
    // person while routing its corrective action to the deal team, with no way to fix it from the form.
    expect(matchResponders(roster, "superintendent", "James Helms").map((r) => r.id)).toEqual(["u1"]);
  });

  it("keeps a DIFFERENT same-named responder selectable while one of them is picked", () => {
    // Only ACTIVE emails are unique, so two people can share a name — and that is exactly when the user needs
    // to switch between them. Suppressing by name would hide both and strand the swap.
    const twins = [
      { id: "t1", name: "James Helms", email: "james.h@trock.test", role: "superintendent" as const },
      { id: "t2", name: "James Helms", email: "jhelms@trock.test", role: "superintendent" as const },
    ];
    expect(matchResponders(twins, "superintendent", "James Helms", { pickedId: "t1" }).map((r) => r.id))
      .toEqual(["t2"]);
  });
});

describe("ResponderPicker", () => {
  it("(a) select-from-roster: a query surfaces a matching suggestion, pressing it calls onChange with the exact name", () => {
    const onChange = jest.fn();
    const { getByLabelText, getByText, queryByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} />,
    );
    const input = getByLabelText(INPUT_LABEL);

    // Focus, then type a query that matches one super — the matching roster row is offered.
    fireEvent(input, "focus");
    fireEvent.changeText(input, "helms");
    expect(onChange).toHaveBeenLastCalledWith("helms", null); // free-text always live while typing

    // A PM (wrong role for a superintendent picker) is never suggested.
    expect(queryByText("Tim Mitchell")).toBeNull();

    // Tapping the suggestion writes the responder's EXACT name (not the lowercase query).
    fireEvent.press(getByText("James Helms"));
    expect(onChange).toHaveBeenLastCalledWith("James Helms", roster[0]);

    // Picking dismisses the list (the row no longer matches an exact value, and focus was cleared).
    expect(queryByText("James Helms")).toBeNull();
  });

  it("(b) typed fallback: typing a name absent from the roster calls onChange with the typed value", () => {
    const onChange = jest.fn();
    const { getByLabelText, queryByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} />,
    );
    const input = getByLabelText(INPUT_LABEL);
    fireEvent(input, "focus");
    fireEvent.changeText(input, "Someone Not In Roster");

    expect(onChange).toHaveBeenLastCalledWith("Someone Not In Roster", null);
    // no roster row matches the off-roster query → no suggestions rendered
    expect(queryByText("James Helms")).toBeNull();
    expect(queryByText("Jamal Wright")).toBeNull();
  });

  it("(c) degrade on error: still calls onChange on typing and renders no suggestions", () => {
    const onChange = jest.fn();
    const { getByLabelText, queryByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} error="Could not load the responder list." />,
    );
    const input = getByLabelText(INPUT_LABEL);
    fireEvent(input, "focus");
    fireEvent.changeText(input, "jam");

    expect(onChange).toHaveBeenLastCalledWith("jam", null);
    // error set → no suggestions even though "jam" would otherwise match two supers
    expect(queryByText("James Helms")).toBeNull();
    expect(queryByText("Jamal Wright")).toBeNull();
  });

  it("(c) degrade on empty roster: still calls onChange on typing and renders no suggestions", () => {
    const onChange = jest.fn();
    const { getByLabelText, queryByText } = render(
      <ControlledPicker onChange={onChange} responders={[]} />,
    );
    const input = getByLabelText(INPUT_LABEL);
    fireEvent(input, "focus");
    fireEvent.changeText(input, "jam");

    expect(onChange).toHaveBeenLastCalledWith("jam", null);
    expect(queryByText("James Helms")).toBeNull();
  });

  it("(d) stays reusable after a pick: re-focusing + editing reopens suggestions and a second pick works", () => {
    // Guards the selection sequence: on a pick the picker clears `focused` and blurs the native input, so a
    // later re-focus emits onFocus again and the menu comes back. (On device keyboardShouldPersistTaps="handled"
    // keeps the row pressable through the tap, so no onBlur races the onPress — pressing the row is representative.)
    const onChange = jest.fn();
    const { getByLabelText, getByText, queryByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} />,
    );
    const input = getByLabelText(INPUT_LABEL);

    // First selection.
    fireEvent(input, "focus");
    fireEvent.changeText(input, "jam");
    fireEvent.press(getByText("James Helms"));
    expect(onChange).toHaveBeenLastCalledWith("James Helms", roster[0]);
    expect(queryByText("Jamal Wright")).toBeNull(); // menu closed after the pick

    // The user re-focuses and edits — suggestions must reappear (they'd be stuck hidden if the picker didn't
    // reset focus + blur on the prior pick), and a second selection must still work.
    fireEvent(input, "focus");
    fireEvent.changeText(input, "jam");
    expect(getByText("Jamal Wright")).toBeTruthy();
    fireEvent.press(getByText("Jamal Wright"));
    expect(onChange).toHaveBeenLastCalledWith("Jamal Wright", roster[1]);
  });

  it("(e) typing a roster member's EXACT name is still not a pick — the responder argument stays null", () => {
    // The load-bearing case. Name-matching is what let the earlier attempt at this feature silently address a
    // roster member the user never selected: they typed a name that happened to collide, and the server matched
    // it. Only pressing a row may report a responder, so an id can never be inferred from typed text.
    const onChange = jest.fn();
    const { getByLabelText } = render(<ControlledPicker onChange={onChange} responders={roster} />);
    const input = getByLabelText(INPUT_LABEL);

    fireEvent(input, "focus");
    fireEvent.changeText(input, "James Helms");

    expect(onChange).toHaveBeenLastCalledWith("James Helms", null);
  });

  it("(f) editing after a pick reports null again, so the id cannot outlive the name it belonged to", () => {
    // A pick followed by a keystroke must NOT leave the caller holding the picked responder: the trailing
    // report is (editedText, null), which the draft reducer turns into a cleared responder id.
    const onChange = jest.fn();
    const { getByLabelText, getByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} />,
    );
    const input = getByLabelText(INPUT_LABEL);

    fireEvent(input, "focus");
    fireEvent.changeText(input, "jam");
    fireEvent.press(getByText("James Helms"));
    expect(onChange).toHaveBeenLastCalledWith("James Helms", roster[0]);

    // One character of editing — a different person now, as far as the pick is concerned.
    fireEvent(input, "focus");
    fireEvent.changeText(input, "James Helm");
    expect(onChange).toHaveBeenLastCalledWith("James Helm", null);
  });

  it("(g) a cleared pick can be re-picked — the exact-name row comes back once no pick is recorded", () => {
    // The trap this closes: pick James Helms, type one character and delete it. The name reads "James Helms"
    // again but the pick is gone, and with the exact-name row hidden there was no way to restore it — the card
    // would show James while quietly routing its corrective action to the deal team.
    const onChange = jest.fn();
    const { getByLabelText, getByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} initial="James Helms" responderId={null} />,
    );
    const input = getByLabelText(INPUT_LABEL);

    fireEvent(input, "focus");
    expect(getByText("James Helms")).toBeTruthy();
    fireEvent.press(getByText("James Helms"));
    expect(onChange).toHaveBeenLastCalledWith("James Helms", roster[0]);
  });

  it("(i) two same-name responders are distinguishable by screen reader and pick independently", () => {
    // Only ACTIVE emails are unique on the roster, so two people can share a name. Pressing one vs the other
    // now routes this card's corrective action to a different address, and the email is already on screen for
    // sighted users — so the accessibility label has to carry it too, or VoiceOver offers two identical
    // "Select James Helms" buttons.
    const twins: FieldResponderOption[] = [
      { id: "t1", name: "James Helms", email: "james.h@trock.test", role: "superintendent" },
      { id: "t2", name: "James Helms", email: "jhelms@trock.test", role: "superintendent" },
    ];
    const onChange = jest.fn();
    const { getByLabelText } = render(<ControlledPicker onChange={onChange} responders={twins} />);
    fireEvent(getByLabelText(INPUT_LABEL), "focus");

    expect(getByLabelText("Select James Helms, james.h@trock.test")).toBeTruthy();
    fireEvent.press(getByLabelText("Select James Helms, jhelms@trock.test"));
    expect(onChange).toHaveBeenLastCalledWith("James Helms", twins[1]);
  });

  it("(h) with the pick recorded, the exact-name row stays hidden (nothing to re-offer)", () => {
    const onChange = jest.fn();
    const { getByLabelText, queryByText } = render(
      <ControlledPicker onChange={onChange} responders={roster} initial="James Helms" responderId="u1" />,
    );
    fireEvent(getByLabelText(INPUT_LABEL), "focus");
    expect(queryByText("James Helms")).toBeNull();
  });
});
