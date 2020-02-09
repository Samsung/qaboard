import React from "react";
import { Callout, Intent, Classes, Button } from "@blueprintjs/core";
import { Container } from "./layout";


class ErrorPage extends React.Component {
	render() {
		let subject = encodeURIComponent("[qa] bug report");
		let error = this.props.error.toString()

		let componentStack = (this.props.info || {}).componentStack
		let body = encodeURIComponent(`URL: ${document.URL}\nerror: ${error}\ncomponentStack: ${componentStack}`)
		return <Container>
			<Callout intent={Intent.DANGER} title="Sorry, something went wrong!">
				<p>Try refreshing the page. If you're lucky, try the <a href={`http://qa:3000${window.location.pathname}`}>staging version</a></p>
				<p><b>Point of contact:</b> Arthur Flam <span className={Classes.TEXT_MUTED}>(+972-(0)58-706-2016) WhatsApp/Phone </span></p>
				<p><a href={`mailto:arthur.flam@samsung.com?subject=${subject}&body=${body}`}><Button>Report the bug</Button></a></p>
				<p><code dangerouslySetInnerHTML={{ __html: error || "" }}></code></p>
				<p><code dangerouslySetInnerHTML={{ __html: componentStack || "" }}></code></p>
			</Callout>
		</Container>
	}
}

export default ErrorPage;