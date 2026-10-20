import { OverlayToaster, Position } from "@blueprintjs/core";
import "./toaster.css";
import { isHandledMessage } from "./api/http";

// Since @blueprintjs/core@6 (React 18+ rendering), creating a toaster is async
const toasterPromise = OverlayToaster.create({
    position: Position.BOTTOM,
    className: "qa-toaster",
});

// What older backends answer to logged-out users. 401 answers get one toast, with a "Log in" button
// (see components/authentication/login.jsx): we skip the toasts of each action that repeat it.
const LOGIN_REQUIRED_ERROR = "You need to be logged-in to do this.";
const LOGIN_TOAST_KEY = "login-required"; // the key of its toast

export const toaster = {
    show: (props, key) => {
        const message = props?.message;
        if (key !== LOGIN_TOAST_KEY && typeof message === 'string' && (message.includes(LOGIN_REQUIRED_ERROR) || isHandledMessage(message)))
            return Promise.resolve();
        return toasterPromise.then(toaster => toaster.show(props, key));
    },
    dismiss: key => toasterPromise.then(toaster => toaster.dismiss(key)),
    clear: () => toasterPromise.then(toaster => toaster.clear()),
};
