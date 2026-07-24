import React, { useState } from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ResponderPicker, matchResponders } from "../ResponderPicker";
import type { FieldResponderOption, FieldResponderRole } from "../../api/types";

// A tiny controlled host so the picker's `value` tracks typing exactly like the real (dispatch-backed) sites —
// the suggestion filter reads `value`, so an uncontrolled render would freeze it at "". onChange is spied.
function ControlledPicker({
  onChange,
  role = "superintendent",
  responders,
  error = null,
  initial = "",
}: {
  onChange: (name: string) => void;
  role?: FieldResponderRole;
  responders: FieldResponderOption[];
  error?: string | null;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ResponderPicker
      value={value}
      onChange={(name) => {
        setValue(name);
        onChange(name);
      }}
      role={role}
      responders={responders}
      error={error}
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

  it("excludes an entry whose name exactly equals the current value (already picked)", () => {
    expect(matchResponders(roster, "superintendent", "James Helms")).toEqual([]);
    expect(matchResponders(roster, "superintendent", "james helms")).toEqual([]);
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
    expect(onChange).toHaveBeenLastCalledWith("helms"); // free-text always live while typing

    // A PM (wrong role for a superintendent picker) is never suggested.
    expect(queryByText("Tim Mitchell")).toBeNull();

    // Tapping the suggestion writes the responder's EXACT name (not the lowercase query).
    fireEvent.press(getByText("James Helms"));
    expect(onChange).toHaveBeenLastCalledWith("James Helms");

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

    expect(onChange).toHaveBeenLastCalledWith("Someone Not In Roster");
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

    expect(onChange).toHaveBeenLastCalledWith("jam");
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

    expect(onChange).toHaveBeenLastCalledWith("jam");
    expect(queryByText("James Helms")).toBeNull();
  });
});
