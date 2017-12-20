"""
Entry point for uwsgi

Can 100% be ignored if you run the application via `flask run`
"""
from server import app

if __name__ == "__main__":
    app.run(threaded=True, host='0.0.0.0', debug=True)
