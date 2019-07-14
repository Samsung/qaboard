/*
 * Copyright 2016 Palantir Technologies, Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from "react";
import { AnchorButton, Button, Code, Intent } from "@blueprintjs/core";


class ButtonsExample extends React.PureComponent {
    state = {
        active: false,
        disabled: false,
        iconOnly: false,
        intent: Intent.NONE,
        large: false,
        loading: false,
        minimal: false,
        wiggling: false,
    };

    handleActiveChange = (active => this.setState({ active }));
    handleDisabledChange = (disabled => this.setState({ disabled }));
    handleIconOnlyChange = (iconOnly => this.setState({ iconOnly }));
    handleLargeChange = (large => this.setState({ large }));
    handleLoadingChange = (loading => this.setState({ loading }));
    handleMinimalChange = (minimal => this.setState({ minimal }));
    handleIntentChange = ((intent) => this.setState({ intent }));

    wiggleTimeoutId = 0;

    componentWillUnmount() {
        window.clearTimeout(this.wiggleTimeoutId);
    }

    render() {
        const { iconOnly, ...buttonProps } = this.state;

        return (
            <>
                <div>
                    <p />
                    <Button
                        className={this.state.wiggling ? "docs-wiggle" : ""}
                        icon="refresh"
                        onClick={this.props.func}
                        {...buttonProps}
                    >
                        {!iconOnly && "crop example"}
                    </Button>
                </div>
            </>
        );
    }

    func = () => {
        console.log("button pressed")
    };
}

export default ButtonsExample;