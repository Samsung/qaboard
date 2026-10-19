import { OverlayToaster, Position } from "@blueprintjs/core";
import "./toaster.css";

// Since @blueprintjs/core@6 (React 18+ rendering), creating a toaster is async
const toasterPromise = OverlayToaster.create({
    position: Position.BOTTOM,
    className: "qa-toaster",
});

// What the backend answers to logged-out users (see components/authentication/login.jsx)
const LOGIN_REQUIRED_ERROR = "You need to be logged-in to do this.";

export const toaster = {
    show: (props, key) => {
        if (typeof props?.message === 'string' && props.message.includes(LOGIN_REQUIRED_ERROR)) return Promise.resolve();
        return toasterPromise.then(toaster => toaster.show(props, key));
    },
    dismiss: key => toasterPromise.then(toaster => toaster.dismiss(key)),
    clear: () => toasterPromise.then(toaster => toaster.clear()),
};
