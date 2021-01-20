"""
Log-in Authentication for qaboard users and LDAP.
"""
from flask import Blueprint, render_template, redirect, url_for, request, flash
from werkzeug.security import generate_password_hash, check_password_hash
from backend import app, db_session
from ..models import User


@app.route('/api/v1/user/signup/', methods=['POST'])
def signup_post():
  print("###signup_post###")
  email = request.form.get('email')
  name = request.form.get('username')
  password = request.form.get('password')
  print(email, name,password)
  
  name = 'qaboard'
  password = 'password'
  
  # return "nothing" #DEBUG
  # user = User.query.filter_by(email=email).first() # if this returns a user, then the email already exists in database

  # if user: # if a user is found, we want to redirect back to signup page so user can try again
  #   flash('Email address already exists')
  #   return redirect(url_for('auth.signup'))

  # create a new user with the form data. Hash the password so the plaintext version isn't saved.
  new_user = User(email=email, name=name, password=generate_password_hash(password, method='sha256'))

  # add the new user to the database
  db_session.add(new_user)
  db_session.commit()
  return redirect(url_for('auth.login'))