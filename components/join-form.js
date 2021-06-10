import { html, Component } from "../lib/index.js";

export default class JoinForm extends Component {
	state = {
		channel: "#",
	};

	constructor(props) {
		super(props);

		this.handleChange = this.handleChange.bind(this);
		this.handleSubmit = this.handleSubmit.bind(this);
	}

	handleChange(event) {
		let target = event.target;
		let value = target.type == "checkbox" ? target.checked : target.value;
		this.setState({ [target.name]: value });
	}

	handleSubmit(event) {
		event.preventDefault();

		let params = {
			channel: this.state.channel,
		};

		this.props.onSubmit(params);
	}

	render() {
		return html`
			<form onChange=${this.handleChange} onSubmit=${this.handleSubmit}>
				<label>
					Channel:<br/>
					<input type="text" name="channel" value=${this.state.channel} autofocus required/>
				</label>
				<br/>

				<br/>
				<button>Join</button>
			</form>
		`;
	}
}
