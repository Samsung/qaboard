import React, { Component } from 'react';
import Reboot from 'material-ui/Reboot';
import 'typeface-roboto'

import logo from './logo.svg';
import './App.css';
import Button from 'material-ui/Button';

class App extends Component {
  render() {
    return (
      <div className="App">
        <Reboot />
        <header className="App-header">
          <img src={logo} className="App-logo" alt="logo" />
          <h1 className="App-title">Welcome to React</h1>
        </header>
        <p className="App-intro">
          To get started, edit <code>src/App.js</code> and save to reload.
        </p>
        <Button raised color="primary"/>
      </div>
    );
  }
}

export default App;
