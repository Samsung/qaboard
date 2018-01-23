import React, { Component } from 'react';
import {
  BrowserRouter as Router,
  Route,
  Link
} from 'react-router-dom'

import Reboot from 'material-ui/Reboot';
import 'typeface-roboto'

import logo from './logo.svg';
import './App.css';

import Button from 'material-ui/Button';

import { get } from 'axios';


var ci_api = 'http://gpu09-dt:5000/api/v1/';

// https://github.com/axios/axios
get(`${ci_api}ci_commits`, {
    params: {
      // ID: 12345
    },
    headers: {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
    }
  })
  .then(function (response) {
    console.log(response.meta);
    console.log(response.data);
  })
  .catch(function (error) {
    console.error(error);
  });


class App extends Component {
  render() {
    return (
      <Router>
        <div className="App">
          <Reboot />
          <ul>
            <li><Link to="/">Home</Link></li>
            <li><Link to="/about">About</Link></li>
            <li><Link to="/topics">Topics</Link></li>
          </ul>
          <header className="App-header">
            <img src={logo} className="App-logo" alt="logo" />
            <h1 className="App-title">SLAM Tuning</h1>
          </header>

          <hr/>

          <Route exact path="/" component={Home}/>
        </div>
      </Router>

    );
  }
}

// <Route path="/about" component={About}/>
// <Route path="/topics" component={Topics}/>


const Home = () => (
  <div>
    <h2>Home</h2>
    <p className="App-intro">
      Edit <code>src/some-code.js</code> and save to reload.
    </p>
    <Button raised color="primary">try that</Button>
  </div>
)

export default App;
