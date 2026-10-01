import React from "react";
import { Callout, Intent, Button } from "@blueprintjs/core";
import { Container } from "./layout";


class ErrorPage extends React.Component {
	render() {
		let subject = encodeURIComponent("[qa] bug report");
		let error = this.props.error.toString()

		let componentStack = (this.props.info || {}).componentStack
		let body = encodeURIComponent(`URL: ${document.URL}\nerror: ${error}\ncomponentStack: ${componentStack}`)
		// QABOARD_SUPPORT_URL can be an email (mailto:) or e.g. an issue tracker
		const support_url = this.props.support_url || "https://github.com/Samsung/qaboard/issues"
		const report_url = support_url.startsWith("mailto:") ? `${support_url}?subject=${subject}&body=${body}` : support_url
		return <Container>
			<Callout intent={Intent.DANGER} title="Sorry, something went wrong!">
				<p>Try refreshing the page..?</p>
				<p><a href={report_url} rel="noopener noreferrer" target="_blank"><Button>Report the bug</Button></a></p>
				<p><code dangerouslySetInnerHTML={{ __html: error || "" }}></code></p>
				<p><code dangerouslySetInnerHTML={{ __html: componentStack || "" }}></code></p>
			</Callout>
		</Container>
	}
}

export default ErrorPage;