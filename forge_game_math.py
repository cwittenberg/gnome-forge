#!/usr/bin/env python3
import math

class ForgeVector2:
    def __init__(self, x=0.0, y=0.0):
        self.x = float(x)
        self.y = float(y)
    def __add__(self, other):
        return ForgeVector2(self.x + other.x, self.y + other.y)
    def __sub__(self, other):
        return ForgeVector2(self.x - other.x, self.y - other.y)
    def __mul__(self, scalar):
        return ForgeVector2(self.x * scalar, self.y * scalar)
    def magnitude(self):
        return math.sqrt(self.x**2 + self.y**2)
    def normalize(self):
        mag = self.magnitude()
        if mag == 0: return ForgeVector2(0, 0)
        return ForgeVector2(self.x / mag, self.y / mag)
    def distance_to(self, other):
        return math.sqrt((self.x - other.x)**2 + (self.y - other.y)**2)

class ForgeVector3:
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x = float(x)
        self.y = float(y)
        self.z = float(z)
    def __add__(self, other):
        return ForgeVector3(self.x + other.x, self.y + other.y, self.z + other.z)
    def __sub__(self, other):
        return ForgeVector3(self.x - other.x, self.y - other.y, self.z - other.z)
    def __mul__(self, scalar):
        return ForgeVector3(self.x * scalar, self.y * scalar, self.z * scalar)
    def magnitude(self):
        return math.sqrt(self.x**2 + self.y**2 + self.z**2)
    def normalize(self):
        mag = self.magnitude()
        if mag == 0: return ForgeVector3(0, 0, 0)
        return ForgeVector3(self.x / mag, self.y / mag, self.z / mag)
    def cross(self, other):
        return ForgeVector3(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x
        )

class ForgeAABB:
    def __init__(self, x, y, width, height):
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        
    def intersects(self, other):
        return (self.x < other.x + other.width and
                self.x + self.width > other.x and
                self.y < other.y + other.height and
                self.y + self.height > other.y)
                
    def center(self):
        return ForgeVector2(self.x + self.width / 2, self.y + self.height / 2)
        
    def get_overlap(self, other):
        if not self.intersects(other):
            return ForgeVector2(0, 0)
            
        dx = self.center().x - other.center().x
        dy = self.center().y - other.center().y
        
        overlap_x = (self.width / 2 + other.width / 2) - abs(dx)
        overlap_y = (self.height / 2 + other.height / 2) - abs(dy)
        
        if overlap_x < overlap_y:
            return ForgeVector2(overlap_x * (1 if dx > 0 else -1), 0)
        else:
            return ForgeVector2(0, overlap_y * (1 if dy > 0 else -1))