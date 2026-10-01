import { OverlayToaster, Position } from "@blueprintjs/core";

// Since @blueprintjs/core@6 (React 18+ rendering), creating a toaster is async
const toasterPromise = OverlayToaster.create({
    position: Position.BOTTOM,
});

export const toaster = {
    show: (props, key) => toasterPromise.then(toaster => toaster.show(props, key)),
    dismiss: key => toasterPromise.then(toaster => toaster.dismiss(key)),
    clear: () => toasterPromise.then(toaster => toaster.clear()),
};
