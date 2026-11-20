import math

class SphericalObserver:
    def __init__(self):
        self.center = {"x": 0.0, "y": 0.0, "z": 0.0}
        self.unity = 1.0
        self.state_coordinates = {"x": 0.0, "y": 0.0, "z": 0.0}

    def converge_to_unity(self, vector):
        magnitude = math.sqrt(sum(v**2 for v in vector.values()))
        if magnitude == 0: return self.center
        return {k: v / magnitude for k, v in vector.items()}

    def jump_to_state(self, x, y, z):
        new_state = {"x": x, "y": y, "z": z}
        self.state_coordinates = self.converge_to_unity(new_state)
        return self.state_coordinates

# Initialize system observer
soo = SphericalObserver()
